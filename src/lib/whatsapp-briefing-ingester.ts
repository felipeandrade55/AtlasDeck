/**
 * WhatsApp briefing ingester — robust, agent-independent audit trail.
 *
 * The original briefing system depended on the model voluntarily calling the
 * `whatsapp_briefing_log` MCP tool before every reply. Models skip it (context
 * pressure, Codex overflow), so the briefing page was empty even though the bot
 * had answered people. This module stops trusting the model: OpenClaw already
 * records every message in `agents/<id>/sessions/<id>.jsonl`, so we read those
 * transcripts and reconstruct the briefing from REAL traffic.
 *
 * Reality of the transcript format (verified on the VPS):
 *   - line 0: {"type":"session",...} prelude (no channel/sender field)
 *   - role:"user"     → content is a STRING = the inbound WhatsApp message
 *   - role:"assistant"→ content is an array of blocks: "text" (internal, e.g.
 *                        "HEARTBEAT_OK") or "toolCall"
 *   - the reply that actually goes to WhatsApp is a toolCall name:"message"
 *     with (arguments|input).message and action:"send" — NOT a text block
 *   - role:"toolResult" → tool output (ignored)
 *   - heartbeat traffic ("Read HEARTBEAT.md… reply HEARTBEAT_OK",
 *     heartbeat_respond) is noise and must be filtered
 *   - the transcript does NOT carry a per-message sender, so we group by
 *     CONVERSATION (= session file), not by individual contact
 *
 * Idempotent: a stable dedup_key per (session, inbound line) means re-reading a
 * file never double-inserts. We re-parse a whole file when it changes (small
 * files; dedup makes re-inserts no-ops) and skip unchanged files via cursor.
 */
import fs from "fs";
import path from "path";
import { getOpenClawDir } from "./openclaw-config";
import {
  ingestBriefingRow,
  getIngestCursor,
  upsertIngestCursor,
  type BriefingEntryInput,
} from "./whatsapp-briefing-db";

const PEEK_BYTES = 65536;
const SUMMARY_MAX = 280;
const EXCERPT_MAX = 1000;
const REPLY_MAX = 4000;
const DEFAULT_SINCE_DAYS = 30;

export interface DiscoveredSession {
  agentId: string;
  /** filename without .jsonl — stable conversation key */
  stem: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface IngestResult {
  scanned: number;
  whatsappFiles: number;
  filesProcessed: number;
  filesSkipped: number;
  inserted: number;
  deduped: number;
  /** Only populated in dryRun — the entries that WOULD be written. */
  planned?: PlannedEntry[];
}

export interface PlannedEntry {
  conversation: string;
  senderName: string | null;
  summary: string;
  botReply: string | null;
  actionTaken: string;
  createdAtIso: string;
  dedupKey: string;
}

export interface IngestOptions {
  dryRun?: boolean;
  /** Only scan session files modified within this many days. */
  sinceDays?: number;
  /** Cap on session files to inspect (newest first). */
  maxFilesScan?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

function peekIsWhatsapp(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(PEEK_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return /whatsapp/i.test(buf.toString("utf8", 0, n));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Walk OPENCLAW/agents/<id>/sessions and return WhatsApp session files. */
export function discoverWhatsappSessions(opts: IngestOptions = {}): DiscoveredSession[] {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const agentsDir = path.join(getOpenClawDir(), "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const candidates: DiscoveredSession[] = [];
  let agentIds: string[];
  try {
    agentIds = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.includes(".reset.")) continue;
      if (f.endsWith(".trajectory.jsonl")) continue;
      const filePath = path.join(sessionsDir, f);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) continue;
      candidates.push({
        agentId,
        stem: f.replace(/\.jsonl$/, ""),
        filePath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited =
    typeof opts.maxFilesScan === "number" ? candidates.slice(0, opts.maxFilesScan) : candidates;
  return limited.filter((s) => peekIsWhatsapp(s.filePath));
}

// ── Noise filters ───────────────────────────────────────────────────────────

function isHeartbeatInbound(text: string): boolean {
  return (
    /HEARTBEAT\.md/i.test(text) ||
    /reply\s+HEARTBEAT_OK/i.test(text) ||
    /\bHEARTBEAT_OK\b/.test(text)
  );
}

/** A system-only notice (gateway connect/disconnect) with no human content. */
function isSystemOnly(text: string): boolean {
  const stripped = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^System:/i.test(l))
    .join("\n")
    .trim();
  return stripped.length === 0;
}

const MEDIA_PREFIX = /^\[media attached:[^\]]*\]/i;

/** Normalize an inbound user string into a human-facing summary, or null if it
 *  is pure noise (heartbeat / system notice) that should be skipped. */
function normalizeInbound(raw: string): { summary: string; excerpt: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (isHeartbeatInbound(text)) return null;
  if (isSystemOnly(text)) return null;

  if (MEDIA_PREFIX.test(text)) {
    // strip the media boilerplate; keep any caption that follows
    const after = text.replace(MEDIA_PREFIX, "").trim();
    const caption = after
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^To send an image back/i.test(l) && !/MEDIA:/i.test(l))
      .join(" ")
      .trim();
    const summary = caption ? `[mídia] ${caption}` : "[mídia recebida]";
    return { summary: truncate(summary, SUMMARY_MAX), excerpt: truncate(text, EXCERPT_MAX) };
  }

  return { summary: truncate(text, SUMMARY_MAX), excerpt: truncate(text, EXCERPT_MAX) };
}

interface ExtractedSends {
  texts: string[];
  /** true = came from toolCall name:"message" (actual WhatsApp send).
   *  false = came from text blocks (internal reasoning / not actually sent). */
  fromTool: boolean;
}

/** Extract what the bot sent to WhatsApp from an assistant message.
 *  Primary source: toolCall name:"message" → (arguments|input).message.
 *  Fallback: non-heartbeat plain text blocks (internal reasoning, NOT sent).
 *  Callers must check `fromTool` to set the correct actionTaken label. */
function extractSendTexts(message: Record<string, unknown>): ExtractedSends {
  const content = message.content;
  if (!Array.isArray(content)) {
    if (typeof content === "string" && content.trim() && !/\bHEARTBEAT_OK\b/.test(content)) {
      return { texts: [content.trim()], fromTool: false };
    }
    return { texts: [], fromTool: false };
  }
  const sends: string[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = asString(block.type);
    if (type === "toolCall") {
      if (asString(block.name) !== "message") continue;
      const args = (isRecord(block.arguments) ? block.arguments : null) ??
        (isRecord(block.input) ? block.input : null);
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

/** Deduplicate consecutive identical strings (retry noise). */
function dedupeConsecutive(arr: string[]): string[] {
  const out: string[] = [];
  for (const s of arr) if (s !== out[out.length - 1]) out.push(s);
  return out;
}

const NAME_RE =
  /\b(?:Oi|Olá|Ola|Opa|Fala|Entendo|Beleza|Valeu|Obrigado|Obrigada|E aí|E ai),?\s+([A-ZÀ-Ý][a-zà-ÿ]{2,15})\b/g;

/** Best-effort conversation label from names the bot used in its replies. The
 *  transcript has no real sender, so this is a friendly hint, not ground truth. */
function inferConversationName(replyTexts: string[], stem: string): string {
  const names = new Set<string>();
  for (const t of replyTexts) {
    let m: RegExpExecArray | null;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(t)) !== null) {
      names.add(m[1]);
      if (names.size >= 4) break;
    }
    if (names.size >= 4) break;
  }
  if (names.size > 0) return Array.from(names).join(", ");
  return `Conversa WhatsApp · ${stem.slice(-4)}`;
}

function parseTimestamp(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      // epoch seconds vs ms heuristic
      return c < 1e12 ? c * 1000 : c;
    }
    if (typeof c === "string" && c) {
      const t = Date.parse(c);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

interface ParsedLine {
  role: string | null;
  inbound: string | null;
  rawInbound: string | null;
  sends: string[];
  /** true = sends came from toolCall name:"message" (actually sent to WhatsApp).
   *  false = sends came from text blocks (internal reasoning, NOT sent). */
  fromTool: boolean;
  tsMs: number | null;
  lineIndex: number;
}

/** Turn a session file into briefing entry inputs (one per inbound→reply). */
export function parseSessionToEntries(
  session: DiscoveredSession,
  accountIdFallback = "main",
): BriefingEntryInput[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(session.filePath, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }

  const accountId = deriveAccountId(session.stem, accountIdFallback);
  let preludeTs: number | null = null;
  let openClawSessionId: string | null = null;

  const parsed: ParsedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const type = asString(obj.type);
    if (type === "session") {
      preludeTs = parseTimestamp(obj.timestamp) ?? preludeTs;
      openClawSessionId = asString(obj.id) || openClawSessionId;
      continue;
    }
    if (type !== "message" || !isRecord(obj.message)) continue;
    const msg = obj.message;
    const role = asString(msg.role) || null;
    const tsMs = parseTimestamp(msg.timestamp, obj.timestamp);

    if (role === "user") {
      const content = msg.content;
      const str = typeof content === "string" ? content : null;
      parsed.push({ role, inbound: str, rawInbound: str, sends: [], fromTool: false, tsMs, lineIndex: i });
    } else if (role === "assistant") {
      const { texts, fromTool } = extractSendTexts(msg);
      parsed.push({ role, inbound: null, rawInbound: null, sends: texts, fromTool, tsMs, lineIndex: i });
    }
    // toolResult / other → ignored
  }

  // Collect toolCall sends for the conversation-name heuristic (names the bot
  // used in greetings). Only use real sends, not internal reasoning text blocks.
  const allReplyTexts: string[] = [];
  for (const p of parsed) if (p.sends.length && p.fromTool) allReplyTexts.push(...p.sends);

  const entries: BriefingEntryInput[] = [];
  for (let idx = 0; idx < parsed.length; idx++) {
    const p = parsed[idx];
    if (p.role !== "user" || !p.inbound) continue;
    const norm = normalizeInbound(p.inbound);
    if (!norm) continue; // heartbeat / system noise

    // Gather sends until the next user message. Track whether ANY of them came
    // from a toolCall (= actually sent to WhatsApp) vs only text blocks (=
    // internal reasoning the bot wrote but did NOT send).
    const toolReplies: string[] = [];
    const textReplies: string[] = [];
    for (let j = idx + 1; j < parsed.length; j++) {
      if (parsed[j].role === "user") break;
      if (!parsed[j].sends.length) continue;
      if (parsed[j].fromTool) toolReplies.push(...parsed[j].sends);
      else textReplies.push(...parsed[j].sends);
    }
    // Prefer toolCall sends (real WhatsApp messages); fall back to text only
    // when there were no toolCalls (bot decided not to reply).
    const actualSends = toolReplies.length > 0 ? toolReplies : [];
    const deduped = dedupeConsecutive(actualSends);
    const botReply = deduped.length ? truncate(deduped.join("\n\n"), REPLY_MAX) : null;
    const botRepliedViaText = toolReplies.length === 0 && textReplies.length > 0;
    const createdAtMs = p.tsMs ?? preludeTs ?? session.mtimeMs ?? Date.now();

    // actionTaken:
    //   "respondeu"            → bot used message tool (actual WhatsApp send)
    //   "monitorado"           → bot saw the message but decided not to respond
    //                            (text block reasoning, no toolCall)
    //   "sem resposta"         → no assistant turn followed (bot didn't process)
    const actionTaken = botReply
      ? "respondeu"
      : botRepliedViaText
      ? "monitorado (sem resposta enviada)"
      : "sem resposta";

    entries.push({
      accountId,
      senderJid: `wa:${session.stem}`,
      senderName: null, // filled after loop once we know the conversation name
      summary: norm.summary,
      rawExcerpt: norm.excerpt,
      botReply,
      actionTaken,
      urgency: "normal",
      requiresFollowup: false,
      sessionId: openClawSessionId ?? session.stem,
      source: "transcript",
      dedupKey: `${session.stem}:${p.lineIndex}`,
      createdAtMs,
    });
  }

  if (entries.length) {
    const name = inferConversationName(allReplyTexts, session.stem);
    for (const e of entries) e.senderName = name;
  }
  return entries;
}

function deriveAccountId(stem: string, fallback: string): string {
  const m = stem.match(/-account-([a-z0-9_-]+)$/i);
  return m ? m[1] : fallback;
}

// ── Sync-on-read throttle ─────────────────────────────────────────────────
// The briefing page / card / diagnostics call this on GET so opening the UI
// reflects fresh traffic. Throttled to avoid re-scanning on every poll.
const READ_THROTTLE_MS = Number.parseInt(
  process.env.WHATSAPP_BRIEFING_READ_THROTTLE_MS || "60000",
  10,
);
let lastReadIngestAt = 0;

/** Run the ingester at most once per throttle window (unless `force`). Safe to
 *  call from any GET handler; swallows errors so a parse hiccup never 500s. */
export function maybeIngestOnRead(force = false): IngestResult | null {
  if (process.env.WHATSAPP_BRIEFING_INGEST_DISABLED === "1") return null;
  const now = Date.now();
  if (!force && now - lastReadIngestAt < READ_THROTTLE_MS) return null;
  lastReadIngestAt = now;
  try {
    return ingestWhatsappBriefings();
  } catch (err) {
    console.warn("[whatsapp-briefing] sync-on-read failed:", err);
    return null;
  }
}

/**
 * Main entry point. Discovers WhatsApp sessions, incrementally re-parses the
 * ones that changed, and writes briefing rows (idempotent). In dryRun mode it
 * writes nothing and returns the planned entries for inspection.
 */
export function ingestWhatsappBriefings(opts: IngestOptions = {}): IngestResult {
  const dryRun = !!opts.dryRun;
  const sessions = discoverWhatsappSessions(opts);

  let filesProcessed = 0;
  let filesSkipped = 0;
  let inserted = 0;
  let deduped = 0;
  const planned: PlannedEntry[] = [];

  for (const session of sessions) {
    const cursor = dryRun ? null : getIngestCursor(session.filePath);
    if (
      cursor &&
      session.sizeBytes === cursor.lastSize &&
      session.mtimeMs <= cursor.lastMtimeMs
    ) {
      filesSkipped += 1;
      continue;
    }
    filesProcessed += 1;

    const entries = parseSessionToEntries(session);
    for (const entry of entries) {
      if (dryRun) {
        planned.push({
          conversation: entry.senderJid,
          senderName: entry.senderName ?? null,
          summary: entry.summary,
          botReply: entry.botReply ?? null,
          actionTaken: entry.actionTaken ?? "",
          createdAtIso: new Date(entry.createdAtMs ?? Date.now()).toISOString(),
          dedupKey: entry.dedupKey ?? "",
        });
        continue;
      }
      const isNew = ingestBriefingRow(entry);
      if (isNew) inserted += 1;
      else deduped += 1;
    }

    if (!dryRun) {
      upsertIngestCursor(session.filePath, {
        lastSize: session.sizeBytes,
        lastMtimeMs: session.mtimeMs,
        lastLine: 0,
      });
    }
  }

  return {
    scanned: sessions.length,
    whatsappFiles: sessions.length,
    filesProcessed,
    filesSkipped,
    inserted,
    deduped,
    ...(dryRun ? { planned } : {}),
  };
}
