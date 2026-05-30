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
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    acknowledgedAt: (row.acknowledged_at as number | null) ?? null,
  };
}

export function logBriefing(input: BriefingEntryInput): BriefingEntry {
  const now = Date.now();
  const id = `brf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db()
    .prepare(
      `INSERT INTO assessor_conversations
         (id, account_id, sender_jid, sender_name, summary, urgency,
          action_taken, requires_followup, raw_excerpt, created_at, updated_at)
       VALUES (@id, @accountId, @senderJid, @senderName, @summary, @urgency,
               @actionTaken, @requiresFollowup, @rawExcerpt, @createdAt, @updatedAt)`,
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
      createdAt: now,
      updatedAt: now,
    });
  return rowToEntry(
    db().prepare("SELECT * FROM assessor_conversations WHERE id = ?").get(id) as Record<
      string,
      unknown
    >,
  );
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
