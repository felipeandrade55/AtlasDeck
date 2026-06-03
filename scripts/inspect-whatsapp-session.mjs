#!/usr/bin/env node
/**
 * READ-ONLY diagnostic. Reveals the real shape of OpenClaw WhatsApp session
 * transcripts so we can build the briefing ingester without guessing the
 * format. Touches nothing — only reads. Run on the VPS:
 *
 *   node scripts/inspect-whatsapp-session.mjs
 *
 * It prints, for the most recent WhatsApp session files:
 *   - the session key / prelude (where sender JID usually lives)
 *   - a compact walk of each message (type, role, text/tool, sender hints)
 *
 * Message bodies are truncated to keep output small; sender-bearing prefixes
 * are kept intact so we can see how the remetente is encoded.
 */
import fs from "fs";
import os from "os";
import path from "path";

const OPENCLAW_DIR =
  process.env.OPENCLAW_DIR || path.join(os.homedir(), ".openclaw");
const AGENTS_DIR = path.join(OPENCLAW_DIR, "agents");

const TRUNC = 280; // keep sender prefixes visible, trim long bodies
const MAX_FILES = 3; // most-recent WhatsApp sessions to dump
const MAX_LINES_PER_FILE = 120;

function trunc(s, n = TRUNC) {
  if (typeof s !== "string") return s;
  return s.length <= n ? s : s.slice(0, n) + ` …(+${s.length - n} chars)`;
}

// crude JID/phone sniffers so we can spot where sender identity lives
const JID_RE = /\d{6,}@(?:s\.whatsapp\.net|g\.us|c\.us|lid)/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

function sniffSender(str) {
  if (typeof str !== "string") return null;
  const jid = str.match(JID_RE);
  if (jid) return `JID=${jid[0]}`;
  const phone = str.match(PHONE_RE);
  if (phone) return `phone?=${phone[0].trim()}`;
  return null;
}

function listSessionFiles() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`No agents dir at ${AGENTS_DIR}`);
    return [];
  }
  const out = [];
  for (const agent of fs.readdirSync(AGENTS_DIR)) {
    const dir = path.join(AGENTS_DIR, agent, "sessions");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.includes(".reset.")) continue;
      if (f.endsWith(".trajectory.jsonl")) continue;
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ agent, file: f, full, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function peekIsWhatsapp(full) {
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8", 0, n);
    return /whatsapp/i.test(head);
  } catch {
    return false;
  }
}

function shortBlock(block) {
  if (!block || typeof block !== "object") return String(block);
  const t = block.type;
  if (t === "text") {
    const sniff = sniffSender(block.text);
    return `text${sniff ? ` <${sniff}>` : ""}: ${trunc(block.text)}`;
  }
  if (t === "tool_use") return `tool_use[${block.name}] input=${trunc(JSON.stringify(block.input))}`;
  if (t === "tool_result")
    return `tool_result: ${trunc(
      typeof block.content === "string" ? block.content : JSON.stringify(block.content),
    )}`;
  return `${t}: ${trunc(JSON.stringify(block))}`;
}

function dumpLine(idx, obj) {
  const type = obj.type || "?";

  // Non-message records (session prelude, system, model_change) — print
  // structural keys + sender sniff, since the prelude often carries the peer.
  if (type !== "message") {
    const keys = Object.keys(obj);
    const sniff = sniffSender(JSON.stringify(obj));
    console.log(
      `  [${idx}] <${type}> keys=${JSON.stringify(keys)}${sniff ? ` <${sniff}>` : ""}`,
    );
    // for the very structural ones, show the whole thing (it's metadata, not a body)
    if (["session", "model_change", "meta", "system"].includes(type)) {
      console.log(`        ${trunc(JSON.stringify(obj), 600)}`);
    }
    return;
  }

  const msg = obj.message || {};
  const role = msg.role || obj.role || "?";
  const content = msg.content ?? obj.content;
  console.log(`  [${idx}] message role=${role}`);
  if (typeof content === "string") {
    const sniff = sniffSender(content);
    console.log(`        str${sniff ? ` <${sniff}>` : ""}: ${trunc(content)}`);
  } else if (Array.isArray(content)) {
    for (const b of content) console.log(`        ${shortBlock(b)}`);
  } else {
    console.log(`        (content shape: ${typeof content}) ${trunc(JSON.stringify(content))}`);
  }
}

function main() {
  console.log(`OPENCLAW_DIR=${OPENCLAW_DIR}`);
  const all = listSessionFiles();
  console.log(`Total session files: ${all.length}`);
  const wa = all.filter((s) => peekIsWhatsapp(s.full));
  console.log(`WhatsApp session files (by "whatsapp" peek): ${wa.length}`);
  for (const s of wa.slice(0, 12)) {
    console.log(
      `  - ${s.agent}/${s.file}  (${(s.size / 1024).toFixed(0)}KB, mtime ${new Date(
        s.mtimeMs,
      ).toISOString()})`,
    );
  }

  for (const s of wa.slice(0, MAX_FILES)) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`FILE: ${s.agent}/${s.file}`);
    console.log("=".repeat(72));
    let lines;
    try {
      lines = fs.readFileSync(s.full, "utf8").split(/\r?\n/).filter(Boolean);
    } catch (e) {
      console.log(`  (could not read: ${e.message})`);
      continue;
    }
    console.log(`  ${lines.length} lines total; showing first ${MAX_LINES_PER_FILE}`);
    for (let i = 0; i < Math.min(lines.length, MAX_LINES_PER_FILE); i++) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        console.log(`  [${i}] <unparseable> ${trunc(lines[i], 120)}`);
        continue;
      }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) dumpLine(i, obj);
    }
  }

  console.log(`\nDone. Paste this output back so we can build the ingester.`);
}

main();
