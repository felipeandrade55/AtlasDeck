/**
 * Bulk-ingest OpenClaw session transcripts into the custom agent_memory.db
 * so the bot can recall past conversations via structured SQL queries
 * instead of grepping raw .jsonl files every time.
 *
 * Each session becomes ONE memory entry with:
 *   - key:        `session-import:<sessionId>` (unique, so re-runs UPSERT)
 *   - category:   `session-import`
 *   - content:    user/assistant exchanges concatenated, truncated to N chars
 *   - importance: heuristic (recent + long = important)
 *
 * Why ONE entry per session and not extracted facts?
 *   - Cheap: no LLM call, runs in seconds
 *   - Idempotent: re-running on same sessions = no-op (key UNIQUE)
 *   - Searchable: bot can `SELECT ... WHERE content LIKE '%keyword%'`
 *   - Future-proof: a Phase 2 LLM-extraction job can later distill these
 *     into atomic facts (one new memory per fact); the raw imports stay
 *     under category=session-import and never conflict.
 *
 * Streaming: callers can iterate the generator returned by `ingestSessions`
 * to get per-file events (start, parsed, inserted, error, done) for SSE.
 */
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { OPENCLAW_DIR } from "./paths";

const AGENTS_DIR = path.join(OPENCLAW_DIR, "agents");
const SHARED_MEMORY_DB = path.join(AGENTS_DIR, "agent_memory.db");

const MAX_CONTENT_CHARS = 12_000; // ~3k tokens; enough for the bot to grep
const MAX_EXCHANGES_PER_SESSION = 80;

// ─── Types ─────────────────────────────────────────────────────────────

export interface SessionFile {
  path: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
}

export interface ParsedSession {
  sessionId: string;
  filePath: string;
  startTime: string | null;
  endTime: string | null;
  /** Length in characters of the concatenated exchanges (for importance heuristic) */
  totalChars: number;
  exchangeCount: number;
  /** Final text we'll insert as memory content (already truncated) */
  preparedContent: string;
}

export interface MemoryEntry {
  agentName: string;
  category: string;
  key: string;
  content: string;
  importance: number;
}

export interface IngestEvent {
  type: "start" | "parsed" | "inserted" | "skipped" | "error" | "done";
  sessionId?: string;
  index?: number;
  total?: number;
  detail?: string;
  /** For "done" event */
  summary?: {
    totalFiles: number;
    inserted: number;
    skipped: number;
    errors: number;
    elapsedMs: number;
  };
}

// ─── Discovery ─────────────────────────────────────────────────────────

export function listSessionFiles(agentId: string): SessionFile[] {
  const dir = path.join(AGENTS_DIR, agentId, "sessions");
  let st: fs.Stats | null = null;
  try { st = fs.statSync(dir); } catch { return []; }
  if (!st.isDirectory()) return [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter(
      (f) =>
        f.endsWith(".jsonl") &&
        // Skip rotated/backup files and metadata sidecars
        !f.includes(".reset.") &&
        !f.endsWith(".codex-app-server.json") &&
        !f.endsWith(".trajectory.jsonl") &&
        !f.endsWith(".trajectory-path.json"),
    );
  } catch { return []; }

  const files: SessionFile[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    let s: fs.Stats;
    try { s = fs.statSync(full); } catch { continue; }
    if (!s.isFile() || s.size === 0) continue;
    files.push({
      path: full,
      sessionId: name.replace(/\.jsonl$/, ""),
      bytes: s.size,
      mtimeMs: s.mtimeMs,
    });
  }
  // Most recent first — those are usually more relevant for recall
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── Parsing ───────────────────────────────────────────────────────────

/**
 * The OpenClaw session .jsonl format is one JSON object per line, where each
 * line is an "event" with shape varying by version. We extract user/assistant
 * text from common shapes:
 *
 *   {"role":"user","content":"...","timestamp":"..."}
 *   {"role":"assistant","content":"...","timestamp":"..."}
 *   {"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *   {"type":"agent_message","text":"..."}
 *
 * Unknown shapes are skipped (we keep the loop tolerant — the goal is
 * "extract whatever text is there", not a strict parser).
 */
function extractTextFromLine(line: string): { role: "user" | "assistant" | null; text: string; timestamp?: string } | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;

  const ts =
    (typeof obj.timestamp === "string" && obj.timestamp) ||
    (typeof obj.time === "string" && obj.time) ||
    (typeof obj.ts === "string" && obj.ts) ||
    undefined;

  // Shape 1: flat {role, content}
  const role = obj.role;
  if (role === "user" || role === "assistant") {
    const content = obj.content;
    if (typeof content === "string" && content.trim()) {
      return { role, text: content.trim(), timestamp: ts };
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const p of content) {
        if (p && typeof p === "object") {
          const pp = p as { text?: unknown; type?: unknown };
          if (typeof pp.text === "string" && pp.text.trim()) parts.push(pp.text.trim());
        }
      }
      if (parts.length) return { role, text: parts.join(" "), timestamp: ts };
    }
  }

  // Shape 2: nested message {type, message: {role, content}}
  const message = obj.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object") {
    const mr = message.role;
    if (mr === "user" || mr === "assistant") {
      const mc = message.content;
      if (typeof mc === "string" && mc.trim()) {
        return { role: mr, text: mc.trim(), timestamp: ts };
      }
      if (Array.isArray(mc)) {
        const parts: string[] = [];
        for (const p of mc) {
          if (p && typeof p === "object") {
            const pp = p as { text?: unknown };
            if (typeof pp.text === "string" && pp.text.trim()) parts.push(pp.text.trim());
          }
        }
        if (parts.length) return { role: mr, text: parts.join(" "), timestamp: ts };
      }
    }
  }

  // Shape 3: {type:"agent_message", text:"..."}
  if (obj.type === "agent_message" && typeof obj.text === "string" && obj.text.trim()) {
    return { role: "assistant", text: obj.text.trim(), timestamp: ts };
  }
  if (obj.type === "user_message" && typeof obj.text === "string" && obj.text.trim()) {
    return { role: "user", text: obj.text.trim(), timestamp: ts };
  }

  return null;
}

export function parseSessionFile(file: SessionFile): ParsedSession | null {
  let raw: string;
  try { raw = fs.readFileSync(file.path, "utf8"); } catch { return null; }
  if (!raw.trim()) return null;

  const lines = raw.split("\n").filter((l) => l.trim());
  const exchanges: Array<{ role: "user" | "assistant"; text: string; ts?: string }> = [];
  let startTime: string | null = null;
  let endTime: string | null = null;

  for (const line of lines) {
    const ex = extractTextFromLine(line);
    if (!ex || ex.role === null) continue;
    if (ex.timestamp) {
      if (!startTime) startTime = ex.timestamp;
      endTime = ex.timestamp;
    }
    exchanges.push({ role: ex.role, text: ex.text, ts: ex.timestamp });
    if (exchanges.length >= MAX_EXCHANGES_PER_SESSION * 2) break; // safety
  }

  if (exchanges.length === 0) return null;

  // Build content: simple "USER: ... / ASSISTANT: ..." format truncated
  const formatted: string[] = [];
  let totalChars = 0;
  for (const ex of exchanges.slice(0, MAX_EXCHANGES_PER_SESSION)) {
    const label = ex.role === "user" ? "USER" : "ASSISTANT";
    const truncated = ex.text.length > 1500 ? ex.text.slice(0, 1500) + "…" : ex.text;
    const piece = `${label}: ${truncated}`;
    if (totalChars + piece.length > MAX_CONTENT_CHARS) {
      formatted.push(`[…${exchanges.length - formatted.length} mensagens truncadas…]`);
      break;
    }
    formatted.push(piece);
    totalChars += piece.length;
  }
  const preparedContent = formatted.join("\n\n");

  return {
    sessionId: file.sessionId,
    filePath: file.path,
    startTime,
    endTime,
    totalChars: preparedContent.length,
    exchangeCount: exchanges.length,
    preparedContent,
  };
}

// ─── Importance heuristic ──────────────────────────────────────────────

/**
 * Score 1-10. Combines:
 *   - recency  (last 7 days = +3, last 30 = +1)
 *   - length   (>5k chars = +2, >1k = +1)
 *   - density  (>10 exchanges = +2)
 *   - base     (5)
 */
function calculateImportance(session: ParsedSession): number {
  let score = 5;
  if (session.endTime) {
    const ageMs = Date.now() - new Date(session.endTime).getTime();
    const days = ageMs / (1000 * 60 * 60 * 24);
    if (days <= 7) score += 3;
    else if (days <= 30) score += 1;
  }
  if (session.totalChars > 5000) score += 2;
  else if (session.totalChars > 1000) score += 1;
  if (session.exchangeCount > 10) score += 2;
  return Math.min(10, Math.max(1, score));
}

// ─── DB ops ────────────────────────────────────────────────────────────

export interface DbState {
  exists: boolean;
  path: string;
  totalEntries: number;
  sessionImportEntries: number;
}

export function checkDbState(): DbState {
  const out: DbState = { exists: false, path: SHARED_MEMORY_DB, totalEntries: 0, sessionImportEntries: 0 };
  try {
    const st = fs.statSync(SHARED_MEMORY_DB);
    if (!st.isFile()) return out;
    out.exists = true;
  } catch { return out; }
  try {
    const total = execFileSync("sqlite3", [SHARED_MEMORY_DB, "SELECT COUNT(*) FROM agent_memory;"], {
      encoding: "utf8", timeout: 3000,
    }).trim();
    const t = Number(total);
    if (Number.isFinite(t)) out.totalEntries = t;
  } catch {}
  try {
    const sess = execFileSync("sqlite3", [SHARED_MEMORY_DB, "SELECT COUNT(*) FROM agent_memory WHERE category='session-import';"], {
      encoding: "utf8", timeout: 3000,
    }).trim();
    const s = Number(sess);
    if (Number.isFinite(s)) out.sessionImportEntries = s;
  } catch {}
  return out;
}

/**
 * Single-row UPSERT via INSERT OR REPLACE. We use execFileSync (NOT execSync)
 * because content may contain shell-special chars; passing args as an array
 * to sqlite3 avoids quoting headaches.
 */
function upsertMemory(entry: MemoryEntry): { ok: boolean; error?: string } {
  if (!fs.existsSync(SHARED_MEMORY_DB)) {
    return { ok: false, error: "agent_memory.db não existe" };
  }
  try {
    // Use bind parameters via .read after writing temp SQL — simplest cross-platform
    // approach: write to a tempfile and run sqlite3 against it.
    const tmpFile = path.join(
      OPENCLAW_DIR,
      `.atlasdeck-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`,
    );
    // Escape single-quote → double-quote in SQL strings
    const esc = (s: string) => s.replace(/'/g, "''");
    const sql =
      `INSERT INTO agent_memory (agent_name, category, key, content, importance, created_at, updated_at) ` +
      `VALUES ('${esc(entry.agentName)}', '${esc(entry.category)}', '${esc(entry.key)}', '${esc(entry.content)}', ${entry.importance}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ` +
      `ON CONFLICT(agent_name, key) DO UPDATE SET ` +
      `content = excluded.content, importance = excluded.importance, ` +
      `updated_at = CURRENT_TIMESTAMP;\n`;
    fs.writeFileSync(tmpFile, sql, "utf8");
    try {
      execFileSync("sqlite3", [SHARED_MEMORY_DB], { input: sql, encoding: "utf8", timeout: 5000 });
      return { ok: true };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Orchestration: generator yielding per-file events ─────────────────

export function* ingestSessions(
  agentId: string,
  opts: { dryRun?: boolean; agentNameInDb?: string; only?: string[] } = {},
): Generator<IngestEvent, void, void> {
  const start = Date.now();
  const agentName = opts.agentNameInDb || agentId;
  let files = listSessionFiles(agentId);
  if (opts.only?.length) {
    const set = new Set(opts.only);
    files = files.filter((f) => set.has(f.sessionId));
  }
  const total = files.length;
  yield { type: "start", total, detail: `${total} session(s) a processar (agentId=${agentId}, agentName=${agentName}, dryRun=${!!opts.dryRun})` };

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const parsed = parseSessionFile(f);
    if (!parsed) {
      skipped += 1;
      yield { type: "skipped", index: i + 1, total, sessionId: f.sessionId, detail: "sem mensagens extraíveis" };
      continue;
    }
    yield { type: "parsed", index: i + 1, total, sessionId: f.sessionId, detail: `${parsed.exchangeCount} exchanges · ${parsed.totalChars} chars` };

    if (opts.dryRun) {
      inserted += 1;
      continue;
    }

    const entry: MemoryEntry = {
      agentName,
      category: "session-import",
      key: `session-import:${f.sessionId}`,
      content: parsed.preparedContent,
      importance: calculateImportance(parsed),
    };
    const res = upsertMemory(entry);
    if (res.ok) {
      inserted += 1;
      yield { type: "inserted", index: i + 1, total, sessionId: f.sessionId, detail: `importance=${entry.importance}` };
    } else {
      errors += 1;
      yield { type: "error", index: i + 1, total, sessionId: f.sessionId, detail: res.error };
    }
  }

  yield {
    type: "done",
    summary: { totalFiles: total, inserted, skipped, errors, elapsedMs: Date.now() - start },
  };
}

// ─── Backup helper ─────────────────────────────────────────────────────

export function backupMemoryDb(): { ok: boolean; backupPath?: string; error?: string } {
  if (!fs.existsSync(SHARED_MEMORY_DB)) return { ok: false, error: "agent_memory.db não existe" };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${SHARED_MEMORY_DB}.backup-${ts}`;
  try {
    fs.copyFileSync(SHARED_MEMORY_DB, backupPath);
    return { ok: true, backupPath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Avoid unused import warning when sqlite3 CLI is missing (execSync used in detect helpers)
void execSync;
