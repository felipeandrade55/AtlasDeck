/**
 * Inter-agent mailbox + operator chat — single SQLite table that carries
 * three flavours of message:
 *   - queued_note:    user → agent, delivered at next checkpoint
 *   - direct_message: user → agent, delivered immediately (interrupt)
 *   - inter_agent:    agent A → agent B mid-task coordination
 *   - review_feedback: orchestrator → specialist after review verdict
 *
 * Pattern lifted from Autensa/Mission-Control's `agent_mailbox` table
 * (https://github.com/crshdn/mission-control). Recipients poll
 * getUnread() at checkpoint boundaries; direct_message broadcasts an SSE
 * event so the recipient can flush its current loop immediately.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { publishEvent } from "./live-events";

const DB_PATH = path.join(process.cwd(), "data", "tasks.db");

export type MailMessageType = "queued_note" | "direct_message" | "inter_agent" | "review_feedback";

export interface MailMessage {
  id: string;
  task_id: string | null;
  from_agent_id: string | null; // null = from human user
  to_agent_id: string;
  subject: string | null;
  body: string;
  message_type: MailMessageType;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_mailbox (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      message_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT,
      delivered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mailbox_recipient
      ON agent_mailbox(to_agent_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_mailbox_task
      ON agent_mailbox(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mailbox_created
      ON agent_mailbox(created_at DESC);
  `);

  return _db;
}

function parseRow(row: Record<string, unknown>): MailMessage {
  return {
    id: row.id as string,
    task_id: (row.task_id as string | null) ?? null,
    from_agent_id: (row.from_agent_id as string | null) ?? null,
    to_agent_id: row.to_agent_id as string,
    subject: (row.subject as string | null) ?? null,
    body: row.body as string,
    message_type: row.message_type as MailMessageType,
    created_at: row.created_at as string,
    read_at: (row.read_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
  };
}

export interface SendMailInput {
  task_id?: string | null;
  from_agent_id?: string | null;
  to_agent_id: string;
  subject?: string;
  body: string;
  message_type: MailMessageType;
}

export function sendMail(input: SendMailInput): MailMessage {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_mailbox (
      id, task_id, from_agent_id, to_agent_id, subject, body, message_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.task_id ?? null,
    input.from_agent_id ?? null,
    input.to_agent_id,
    input.subject ?? null,
    input.body,
    input.message_type,
    now,
  );

  publishEvent({
    event_type: "mailbox.message",
    task_id: input.task_id ?? null,
    agent_id: input.to_agent_id,
    payload: {
      message_id: id,
      from: input.from_agent_id,
      to: input.to_agent_id,
      message_type: input.message_type,
      subject: input.subject ?? null,
      preview: input.body.slice(0, 120),
    },
  });
  return {
    id,
    task_id: input.task_id ?? null,
    from_agent_id: input.from_agent_id ?? null,
    to_agent_id: input.to_agent_id,
    subject: input.subject ?? null,
    body: input.body,
    message_type: input.message_type,
    created_at: now,
    read_at: null,
    delivered_at: null,
  };
}

export interface GetMailOptions {
  task_id?: string;
  to_agent_id?: string;
  from_agent_id?: string;
  message_type?: MailMessageType;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
  sort?: "newest" | "oldest";
}

export function listMail(opts: GetMailOptions = {}): MailMessage[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.task_id) {
    conditions.push("task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.to_agent_id) {
    conditions.push("to_agent_id = ?");
    params.push(opts.to_agent_id);
  }
  if (opts.from_agent_id) {
    conditions.push("from_agent_id = ?");
    params.push(opts.from_agent_id);
  }
  if (opts.message_type) {
    conditions.push("message_type = ?");
    params.push(opts.message_type);
  }
  if (opts.unread_only) {
    conditions.push("read_at IS NULL");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = opts.sort === "oldest" ? "ASC" : "DESC";
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM agent_mailbox ${where} ORDER BY created_at ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(parseRow);
}

export function getUnreadFor(agentId: string): MailMessage[] {
  return listMail({ to_agent_id: agentId, unread_only: true, sort: "oldest", limit: 200 });
}

export function markRead(messageId: string): MailMessage | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_mailbox SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(now, messageId);
  const row = db.prepare("SELECT * FROM agent_mailbox WHERE id = ?").get(messageId) as
    | Record<string, unknown>
    | undefined;
  return row ? parseRow(row) : null;
}

export function markDelivered(messageId: string): MailMessage | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_mailbox SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?").run(now, messageId);
  const row = db.prepare("SELECT * FROM agent_mailbox WHERE id = ?").get(messageId) as
    | Record<string, unknown>
    | undefined;
  return row ? parseRow(row) : null;
}

/**
 * Formats unread mail for injection into an agent's context. Marks the
 * messages as read in the same transaction — this is the "dispatch" of
 * queued notes at a checkpoint boundary.
 */
export function flushUnreadForDispatch(agentId: string): { messages: MailMessage[]; formatted: string } {
  const db = getDb();
  const messages = getUnreadFor(agentId);
  if (messages.length === 0) return { messages: [], formatted: "" };

  const ids = messages.map((m) => m.id);
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE agent_mailbox SET read_at = ?, delivered_at = ? WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(now, now, id);
  })();

  const formatted = messages
    .map((m) => {
      const from = m.from_agent_id ? `@${m.from_agent_id}` : "user";
      const type = m.message_type === "direct_message" ? "[URGENT] " : "";
      const subject = m.subject ? `${m.subject}: ` : "";
      return `${type}${from} → ${subject}${m.body}`;
    })
    .join("\n\n");

  return { messages, formatted };
}

export function deleteMail(messageId: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM agent_mailbox WHERE id = ?").run(messageId);
  return info.changes > 0;
}
