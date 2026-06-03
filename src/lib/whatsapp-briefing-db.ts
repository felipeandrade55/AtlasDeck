/**
 * Briefing log for the WhatsApp "modo Assessor".
 *
 * When the bot is in assistant mode it should write a short structured
 * entry every time someone talks to it — so when Felipe later asks
 * "me passa o briefing de quem falou comigo hoje" the agent has a
 * concrete source of truth instead of guessing from chat history.
 *
 * SQLite-backed (same WAL-mode pattern as memories.db / tasks.db) so
 * the AtlasDeck UI can query the same rows the MCP tools write.
 */
import path from "path";
import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "whatsapp-briefing.db");

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS assessor_conversations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      summary TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'normal'
        CHECK(urgency IN ('low','normal','medium','high','urgent')),
      action_taken TEXT,
      requires_followup INTEGER NOT NULL DEFAULT 0,
      raw_excerpt TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_briefing_sender
      ON assessor_conversations(sender_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_briefing_pending
      ON assessor_conversations(acknowledged_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_briefing_urgency
      ON assessor_conversations(urgency, created_at DESC);
  `);

  // ── Idempotent column migrations ───────────────────────────────────
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so we sniff pragma and
  // ALTER only when missing. Both columns nullable → zero risk to old
  // rows. Wrapped in try/catch defensively in case the table is locked.
  const existing = new Set(
    (conn.prepare("PRAGMA table_info(assessor_conversations)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  // bot_reply_text: literal text the bot said back to the sender. Captured
  // alongside the inbound summary so the user can audit both sides without
  // jumping to Codex session logs.
  if (!existing.has("bot_reply_text")) {
    try {
      conn.exec(`ALTER TABLE assessor_conversations ADD COLUMN bot_reply_text TEXT`);
    } catch {
      // ignore — another writer raced us; harmless
    }
  }
  // session_id: optional Codex thread id (when the MCP server is taught to
  // capture it). Indexed lazily once populated. Lets us correlate briefings
  // with usage-tracking session-level cost rows for per-conversation pricing.
  if (!existing.has("session_id")) {
    try {
      conn.exec(`ALTER TABLE assessor_conversations ADD COLUMN session_id TEXT`);
    } catch {
      // ignore — another writer raced us; harmless
    }
  }
  // source: where the row came from. 'agent' = the model called the
  // whatsapp_briefing_log MCP tool (voluntary, unreliable). 'transcript' =
  // the briefing ingester reconstructed it from the OpenClaw session .jsonl
  // (robust — doesn't depend on the model). Null = legacy/agent.
  if (!existing.has("source")) {
    try {
      conn.exec(`ALTER TABLE assessor_conversations ADD COLUMN source TEXT`);
    } catch {
      // ignore — another writer raced us; harmless
    }
  }
  // dedup_key: stable identity for ingester-created rows ("<sessionId>:<line>")
  // so re-reading a transcript (rotation, manual reprocess, overlapping runs)
  // never double-inserts. Null for agent rows (no dedup — every tool call is a
  // distinct event). Enforced by a PARTIAL unique index (nulls excluded).
  if (!existing.has("dedup_key")) {
    try {
      conn.exec(`ALTER TABLE assessor_conversations ADD COLUMN dedup_key TEXT`);
    } catch {
      // ignore — another writer raced us; harmless
    }
  }
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_briefing_dedup
       ON assessor_conversations(dedup_key) WHERE dedup_key IS NOT NULL`,
  );

  // Incremental cursor for the transcript ingester — same shape as the
  // usage-collector's jsonl_cursors. Lets steady-state runs skip unchanged
  // session files (size + mtime) and resume mid-file (last_line). Kept in
  // THIS db so cursor advances and briefing writes commit to the same file.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS briefing_ingest_cursors (
      file_path TEXT PRIMARY KEY,
      last_size INTEGER NOT NULL DEFAULT 0,
      last_mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_line INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  _db = conn;
  return conn;
}

export type BriefingUrgency = "low" | "normal" | "medium" | "high" | "urgent";

export interface BriefingEntryInput {
  accountId: string;
  senderJid: string;
  senderName?: string | null;
  summary: string;
  urgency?: BriefingUrgency;
  actionTaken?: string | null;
  requiresFollowup?: boolean;
  rawExcerpt?: string | null;
  /** Texto que o bot mandou de volta (se respondeu). Null quando ignorou. */
  botReply?: string | null;
  /** Codex session id (quando o MCP server conseguir capturar). Permite
   *  correlacionar com usage-tracking pra custo por conversa. */
  sessionId?: string | null;
  /** Origem da linha: 'agent' (tool MCP) ou 'transcript' (ingester). */
  source?: "agent" | "transcript" | null;
  /** Chave estável de dedup (só ingester). Conflito → no-op idempotente. */
  dedupKey?: string | null;
  /** Override do created_at (ms). O ingester usa o timestamp ORIGINAL da
   *  mensagem em vez de Date.now() pra janela de 24h ficar correta. */
  createdAtMs?: number | null;
}

export interface BriefingEntry {
  id: string;
  accountId: string;
  senderJid: string;
  senderName: string | null;
  summary: string;
  urgency: BriefingUrgency;
  actionTaken: string | null;
  requiresFollowup: boolean;
  rawExcerpt: string | null;
  botReply: string | null;
  sessionId: string | null;
  source: "agent" | "transcript" | null;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt: number | null;
}

function rowToEntry(row: Record<string, unknown>): BriefingEntry {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    senderJid: row.sender_jid as string,
    senderName: (row.sender_name as string | null) ?? null,
    summary: row.summary as string,
    urgency: (row.urgency as BriefingUrgency) ?? "normal",
    actionTaken: (row.action_taken as string | null) ?? null,
    requiresFollowup: !!(row.requires_followup as number),
    rawExcerpt: (row.raw_excerpt as string | null) ?? null,
    botReply: (row.bot_reply_text as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    source: (row.source as "agent" | "transcript" | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    acknowledgedAt: (row.acknowledged_at as number | null) ?? null,
  };
}

export function logBriefing(input: BriefingEntryInput): BriefingEntry {
  const now = Date.now();
  const createdAt = typeof input.createdAtMs === "number" ? input.createdAtMs : now;
  const id = `brf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // ON CONFLICT targets the PARTIAL unique index on dedup_key (nulls excluded),
  // so agent rows (dedup_key=null) always insert and ingester rows are
  // idempotent: re-reading the same transcript line is a no-op.
  const result = db()
    .prepare(
      `INSERT INTO assessor_conversations
         (id, account_id, sender_jid, sender_name, summary, urgency,
          action_taken, requires_followup, raw_excerpt, bot_reply_text,
          session_id, source, dedup_key, created_at, updated_at)
       VALUES (@id, @accountId, @senderJid, @senderName, @summary, @urgency,
               @actionTaken, @requiresFollowup, @rawExcerpt, @botReply,
               @sessionId, @source, @dedupKey, @createdAt, @updatedAt)
       ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
    )
    .run({
      id,
      accountId: input.accountId,
      senderJid: input.senderJid,
      senderName: input.senderName ?? null,
      summary: input.summary,
      urgency: input.urgency ?? "normal",
      actionTaken: input.actionTaken ?? null,
      requiresFollowup: input.requiresFollowup ? 1 : 0,
      rawExcerpt: input.rawExcerpt ?? null,
      botReply: input.botReply ?? null,
      sessionId: input.sessionId ?? null,
      source: input.source ?? null,
      dedupKey: input.dedupKey ?? null,
      createdAt,
      updatedAt: now,
    });
  // Inserted → fetch by id. Skipped (dedup conflict) → return the existing row.
  const row =
    result.changes > 0
      ? db().prepare("SELECT * FROM assessor_conversations WHERE id = ?").get(id)
      : db()
          .prepare("SELECT * FROM assessor_conversations WHERE dedup_key = ?")
          .get(input.dedupKey ?? "");
  return rowToEntry(row as Record<string, unknown>);
}

/** True if the insert created a new row (false = deduped). Mirrors logBriefing
 *  but returns the insert outcome so the ingester can count new vs skipped. */
export function ingestBriefingRow(input: BriefingEntryInput): boolean {
  const before = input.dedupKey
    ? db()
        .prepare("SELECT 1 FROM assessor_conversations WHERE dedup_key = ?")
        .get(input.dedupKey)
    : undefined;
  if (before) return false;
  logBriefing(input);
  return true;
}

// ── Ingest cursor helpers (mirror usage-collector-jsonl's jsonl_cursors) ──
export interface IngestCursor {
  lastSize: number;
  lastMtimeMs: number;
  lastLine: number;
}

export function getIngestCursor(filePath: string): IngestCursor | null {
  const row = db()
    .prepare(
      "SELECT last_size, last_mtime_ms, last_line FROM briefing_ingest_cursors WHERE file_path = ?",
    )
    .get(filePath) as
    | { last_size: number; last_mtime_ms: number; last_line: number }
    | undefined;
  if (!row) return null;
  return { lastSize: row.last_size, lastMtimeMs: row.last_mtime_ms, lastLine: row.last_line };
}

export function upsertIngestCursor(
  filePath: string,
  cursor: IngestCursor,
): void {
  db()
    .prepare(
      `INSERT INTO briefing_ingest_cursors
         (file_path, last_size, last_mtime_ms, last_line, updated_at)
       VALUES (@filePath, @lastSize, @lastMtimeMs, @lastLine, @updatedAt)
       ON CONFLICT(file_path) DO UPDATE SET
         last_size = excluded.last_size,
         last_mtime_ms = excluded.last_mtime_ms,
         last_line = excluded.last_line,
         updated_at = excluded.updated_at`,
    )
    .run({
      filePath,
      lastSize: cursor.lastSize,
      lastMtimeMs: cursor.lastMtimeMs,
      lastLine: cursor.lastLine,
      updatedAt: Date.now(),
    });
}

/** Count rows by source — used by diagnostics + scheduler logging. */
export function getBriefingCountBySource(): { agent: number; transcript: number; total: number } {
  const rows = db()
    .prepare(
      `SELECT COALESCE(source, 'agent') AS src, COUNT(*) AS n
         FROM assessor_conversations GROUP BY COALESCE(source, 'agent')`,
    )
    .all() as Array<{ src: string; n: number }>;
  let agent = 0;
  let transcript = 0;
  for (const r of rows) {
    if (r.src === "transcript") transcript = r.n;
    else agent += r.n;
  }
  return { agent, transcript, total: agent + transcript };
}

/**
 * Attach (or overwrite) the bot's literal reply to an existing briefing.
 * Used when the agent logs upfront on receipt (per the SHARED_RULES audit
 * directive) and then circles back AFTER replying to fill in what it sent.
 * Cheap to call: indexed by primary key.
 */
export function attachBotReply(id: string, botReply: string): boolean {
  const result = db()
    .prepare(
      `UPDATE assessor_conversations
         SET bot_reply_text = @botReply, updated_at = @now
         WHERE id = @id`,
    )
    .run({ id, botReply, now: Date.now() });
  return result.changes > 0;
}

export interface BriefingQuery {
  accountId?: string;
  sinceMs?: number;
  senderJid?: string;
  urgency?: BriefingUrgency;
  onlyPending?: boolean; // not yet acknowledged by Felipe
  limit?: number;
}

export function listBriefings(q: BriefingQuery = {}): BriefingEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.accountId) {
    where.push("account_id = @accountId");
    params.accountId = q.accountId;
  }
  if (typeof q.sinceMs === "number") {
    where.push("created_at >= @sinceMs");
    params.sinceMs = q.sinceMs;
  }
  if (q.senderJid) {
    where.push("sender_jid = @senderJid");
    params.senderJid = q.senderJid;
  }
  if (q.urgency) {
    where.push("urgency = @urgency");
    params.urgency = q.urgency;
  }
  if (q.onlyPending) {
    where.push("acknowledged_at IS NULL");
  }
  const sql = `
    SELECT * FROM assessor_conversations
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT @limit
  `;
  params.limit = q.limit ?? 100;
  const rows = db().prepare(sql).all(params) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function acknowledgeBriefing(id: string): boolean {
  const result = db()
    .prepare(
      `UPDATE assessor_conversations
       SET acknowledged_at = @now
       WHERE id = @id AND acknowledged_at IS NULL`,
    )
    .run({ id, now: Date.now() });
  return result.changes > 0;
}

export function acknowledgeAllBriefings(accountId?: string): number {
  const sql = accountId
    ? `UPDATE assessor_conversations SET acknowledged_at = @now
         WHERE acknowledged_at IS NULL AND account_id = @accountId`
    : `UPDATE assessor_conversations SET acknowledged_at = @now
         WHERE acknowledged_at IS NULL`;
  const result = db().prepare(sql).run({ now: Date.now(), accountId });
  return result.changes;
}

export interface BriefingSummary {
  totalPending: number;
  bySender: Array<{ senderJid: string; senderName: string | null; count: number }>;
  byUrgency: Record<BriefingUrgency, number>;
  oldestPendingMs: number | null;
  newestPendingMs: number | null;
}

export function summarizeBriefings(accountId?: string): BriefingSummary {
  const where = accountId
    ? "WHERE acknowledged_at IS NULL AND account_id = @accountId"
    : "WHERE acknowledged_at IS NULL";

  const total = (
    db().prepare(`SELECT COUNT(*) as n FROM assessor_conversations ${where}`).get({ accountId }) as {
      n: number;
    }
  ).n;

  const senders = db()
    .prepare(
      `SELECT sender_jid, sender_name, COUNT(*) as n
         FROM assessor_conversations
         ${where}
         GROUP BY sender_jid
         ORDER BY n DESC LIMIT 10`,
    )
    .all({ accountId }) as Array<{ sender_jid: string; sender_name: string | null; n: number }>;

  const urgencies = db()
    .prepare(
      `SELECT urgency, COUNT(*) as n
         FROM assessor_conversations
         ${where}
         GROUP BY urgency`,
    )
    .all({ accountId }) as Array<{ urgency: BriefingUrgency; n: number }>;

  const byUrgency: Record<BriefingUrgency, number> = {
    low: 0,
    normal: 0,
    medium: 0,
    high: 0,
    urgent: 0,
  };
  for (const u of urgencies) byUrgency[u.urgency] = u.n;

  const range = db()
    .prepare(
      `SELECT MIN(created_at) as oldest, MAX(created_at) as newest
         FROM assessor_conversations ${where}`,
    )
    .get({ accountId }) as { oldest: number | null; newest: number | null };

  return {
    totalPending: total,
    bySender: senders.map((s) => ({
      senderJid: s.sender_jid,
      senderName: s.sender_name,
      count: s.n,
    })),
    byUrgency,
    oldestPendingMs: range.oldest,
    newestPendingMs: range.newest,
  };
}
