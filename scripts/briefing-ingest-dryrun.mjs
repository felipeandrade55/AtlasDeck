#!/usr/bin/env node
/**
 * DRY-RUN of the WhatsApp briefing ingester. Self-contained mirror of
 * src/lib/whatsapp-briefing-ingester.ts — writes NOTHING, just prints the
 * briefing entries that WOULD be created from the OpenClaw session transcripts.
 *
 * Run on the VPS to validate extraction (and timestamps) against real data
 * BEFORE enabling writes:
 *
 *   node scripts/briefing-ingest-dryrun.mjs
 *
 * If this output looks right (real conversations, heartbeat filtered, botReply
 * matches what was sent, timestamps sane), the in-app ingester will produce the
 * same rows.
 */
import fs from "fs";
import os from "os";
import path from "path";

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), ".openclaw");
const SINCE_DAYS = Number(process.env.SINCE_DAYS || 30);
const PEEK_BYTES = 65536;
const SUMMARY_MAX = 280;
const REPLY_MAX = 4000;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function truncate(s, n) {
  if (typeof s !== "string") return s;
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function peekIsWhatsapp(filePath, stem) {
  if (/-topic-whatsapp-/i.test(stem)) return true;
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(32768);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return /WhatsApp gateway connected as \+\d/i.test(buf.toString("utf8", 0, n));
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

function discoverWhatsappSessions() {
  const cutoff = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;
  const agentsDir = path.join(OPENCLAW_DIR, "agents");
  if (!fs.existsSync(agentsDir)) return [];
  const out = [];
  for (const agentId of fs.readdirSync(agentsDir)) {
    const dir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.includes(".reset.")) continue;
      if (f.endsWith(".trajectory.jsonl")) continue;
      const filePath = path.join(dir, f);
      let st;
      try { st = fs.statSync(filePath); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < cutoff) continue;
      out.push({ agentId, stem: f.replace(/\.jsonl$/, ""), filePath, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.filter((s) => peekIsWhatsapp(s.filePath, s.stem));
}

function isHeartbeatInbound(text) {
  return /HEARTBEAT\.md/i.test(text) || /reply\s+HEARTBEAT_OK/i.test(text) || /\bHEARTBEAT_OK\b/.test(text);
}
function isSystemOnly(text) {
  const stripped = text.split(/\r?\n/).filter((l) => l.trim() && !/^System:/i.test(l)).join("\n").trim();
  return stripped.length === 0;
}
const MEDIA_PREFIX = /^\[media attached:[^\]]*\]/i;
function normalizeInbound(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  if (isHeartbeatInbound(text)) return null;
  if (isSystemOnly(text)) return null;
  if (MEDIA_PREFIX.test(text)) {
    const after = text.replace(MEDIA_PREFIX, "").trim();
    const caption = after.split(/\r?\n/).filter((l) => l.trim() && !/^To send an image back/i.test(l) && !/MEDIA:/i.test(l)).join(" ").trim();
    return { summary: truncate(caption ? `[mídia] ${caption}` : "[mídia recebida]", SUMMARY_MAX) };
  }
  return { summary: truncate(text, SUMMARY_MAX) };
}

function extractSendTexts(message) {
  const content = message.content;
  if (!Array.isArray(content)) {
    if (typeof content === "string" && content.trim() && !/\bHEARTBEAT_OK\b/.test(content)) return { texts: [content.trim()], fromTool: false };
    return { texts: [], fromTool: false };
  }
  const sends = [];
  const texts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = asString(block.type);
    if (type === "toolCall") {
      if (asString(block.name) !== "message") continue;
      const args = (isRecord(block.arguments) ? block.arguments : null) ?? (isRecord(block.input) ? block.input : null);
      if (!args) continue;
      const action = asString(args.action);
      if (action && action !== "send") continue;
      const msg = asString(args.message).trim();
      if (msg) sends.push(msg);
    } else if (type === "text") {
      const t = asString(block.text).trim();
      if (t && !/\bHEARTBEAT_OK\b/.test(t)) texts.push(t);
    }
  }
  if (sends.length > 0) return { texts: sends, fromTool: true };
  return { texts, fromTool: false };
}

function dedupeConsecutive(arr) {
  const out = [];
  for (const s of arr) if (s !== out[out.length - 1]) out.push(s);
  return out;
}

const NAME_RE = /\b(?:Oi|Olá|Ola|Opa|Fala|Entendo|Beleza|Valeu|Obrigado|Obrigada|E aí|E ai),?\s+([A-ZÀ-Ý][a-zà-ÿ]{2,15})\b/g;
function inferConversationName(replyTexts, stem) {
  const names = new Set();
  for (const t of replyTexts) {
    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(t)) !== null) { names.add(m[1]); if (names.size >= 4) break; }
    if (names.size >= 4) break;
  }
  if (names.size > 0) return Array.from(names).join(", ");
  return `Conversa WhatsApp · ${stem.slice(-4)}`;
}

function parseTimestamp(...cands) {
  for (const c of cands) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c < 1e12 ? c * 1000 : c;
    if (typeof c === "string" && c) { const t = Date.parse(c); if (!Number.isNaN(t)) return t; }
  }
  return null;
}

function parseSessionToEntries(session) {
  let lines;
  try { lines = fs.readFileSync(session.filePath, "utf8").split(/\r?\n/); } catch { return []; }
  let preludeTs = null;
  let tsFieldSeen = false;
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (!isRecord(obj)) continue;
    const type = asString(obj.type);
    if (type === "session") { preludeTs = parseTimestamp(obj.timestamp) ?? preludeTs; continue; }
    if (type !== "message" || !isRecord(obj.message)) continue;
    const msg = obj.message;
    const role = asString(msg.role) || null;
    const tsMs = parseTimestamp(msg.timestamp, obj.timestamp);
    if (tsMs && (msg.timestamp || obj.timestamp)) tsFieldSeen = true;
    if (role === "user") {
      const str = typeof msg.content === "string" ? msg.content : null;
      parsed.push({ role, inbound: str, sends: [], fromTool: false, tsMs, lineIndex: i });
    } else if (role === "assistant") {
      const { texts, fromTool } = extractSendTexts(msg);
      parsed.push({ role, inbound: null, sends: texts, fromTool, tsMs, lineIndex: i });
    }
  }
  const allReplies = [];
  for (const p of parsed) if (p.sends.length && p.fromTool) allReplies.push(...p.sends);
  const entries = [];
  for (let idx = 0; idx < parsed.length; idx++) {
    const p = parsed[idx];
    if (p.role !== "user" || !p.inbound) continue;
    const norm = normalizeInbound(p.inbound);
    if (!norm) continue;
    const toolReplies = [];
    const textReplies = [];
    for (let j = idx + 1; j < parsed.length; j++) {
      if (parsed[j].role === "user") break;
      if (!parsed[j].sends.length) continue;
      if (parsed[j].fromTool) toolReplies.push(...parsed[j].sends);
      else textReplies.push(...parsed[j].sends);
    }
    const deduped = dedupeConsecutive(toolReplies);
    const botReply = deduped.length ? truncate(deduped.join("\n\n"), REPLY_MAX) : null;
    const botRepliedViaText = toolReplies.length === 0 && textReplies.length > 0;
    const actionTaken = botReply ? "respondeu" : botRepliedViaText ? "monitorado (sem resposta enviada)" : "sem resposta";
    const createdAtMs = p.tsMs ?? preludeTs ?? session.mtimeMs ?? Date.now();
    entries.push({
      conversation: `wa:${session.stem}`,
      summary: norm.summary,
      botReply,
      actionTaken,
      createdAtIso: new Date(createdAtMs).toISOString(),
      tsSource: p.tsMs ? "message" : preludeTs ? "prelude" : "mtime",
      dedupKey: `${session.stem}:${p.lineIndex}`,
    });
  }
  const name = entries.length ? inferConversationName(allReplies, session.stem) : null;
  return { entries: entries.map((e) => ({ ...e, senderName: name })), tsFieldSeen };
}

function main() {
  console.log(`OPENCLAW_DIR=${OPENCLAW_DIR}  SINCE_DAYS=${SINCE_DAYS}`);
  const sessions = discoverWhatsappSessions();
  console.log(`WhatsApp session files in window: ${sessions.length}\n`);
  let totalEntries = 0;
  let anyTsField = false;
  for (const s of sessions) {
    const { entries, tsFieldSeen } = parseSessionToEntries(s);
    if (tsFieldSeen) anyTsField = true;
    if (!entries.length) continue;
    console.log("=".repeat(72));
    console.log(`FILE ${s.agentId}/${s.stem}  → ${entries.length} entrada(s)  [label: ${entries[0].senderName}]`);
    console.log("=".repeat(72));
    for (const e of entries) {
      totalEntries++;
      console.log(`  • [${e.createdAtIso} via ${e.tsSource}] ${e.actionTaken}`);
      console.log(`    IN : ${e.summary}`);
      console.log(`    OUT: ${e.botReply ? truncate(e.botReply, 220) : "(sem resposta)"}`);
    }
    console.log("");
  }
  console.log("=".repeat(72));
  console.log(`TOTAL: ${totalEntries} entrada(s) seriam criadas a partir de ${sessions.length} arquivo(s).`);
  console.log(`Timestamp por-mensagem presente no transcript? ${anyTsField ? "SIM (usando timestamp real)" : "NÃO (usando prelúdio/mtime como fallback)"}`);
  console.log("\nNada foi escrito (dry-run). Cole esta saída pra validarmos antes de ligar a escrita.");
}

main();
