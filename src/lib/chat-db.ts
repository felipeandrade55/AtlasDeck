/**
 * Chat persistence layer for the AtlasDeck "Jarvis" UI.
 *
 * Threads group messages exchanged with a specific agent. Messages cover
 * user input, assistant output, and tool calls/results so the UI can render
 * the full transcript without going back to OpenClaw session files.
 *
 * Mirrors the structure of memory-db.ts: lazy singleton, WAL mode, prepared
 * statements, and a parseRow boundary that converts SQLite values to typed
 * objects.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.cwd(), "data", "chats.db");

export type ChatSource = "web" | "telegram" | "openclaw_import" | "worker";

export type ChatRole =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system";

export type ChatMessageStatus = "streaming" | "complete" | "error";

export interface ThreadRow {
  id: string;
  title: string;
  agent_id: string;
  workspace: string | null;
  source: ChatSource;
  source_session_id: string | null;
  pinned: boolean;
  archived: boolean;
  metadata: Record<string, unknown>;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: string | null;
  audio_path: string | null;
  tts_path: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  status: ChatMessageStatus;
  error: string | null;
  created_at: string;
}

export interface ThreadInsert {
  id?: string;
  title?: string;
  agent_id: string;
  workspace?: string | null;
  source?: ChatSource;
  source_session_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MessageInsert {
  id?: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: string | null;
  audio_path?: string | null;
  tts_path?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  status?: ChatMessageStatus;
  error?: string | null;
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
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      workspace TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      source_session_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_agent ON threads(agent_id);
    CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_threads_source_session
      ON threads(source, COALESCE(source_session_id, ''))
      WHERE source_session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      audio_path TEXT,
      tts_path TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'complete',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  return _db;
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseThread(row: Record<string, unknown>): ThreadRow {
  return {
    id: row.id as string,
    title: row.title as string,
    agent_id: row.agent_id as string,
    workspace: (row.workspace as string | null) ?? null,
    source: (row.source as ChatSource) ?? "web",
    source_session_id: (row.source_session_id as string | null) ?? null,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    metadata: safeJson(row.metadata as string | null),
    last_message_at: (row.last_message_at as string | null) ?? null,
    message_count: Number(row.message_count ?? 0),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function parseMessage(row: Record<string, unknown>): MessageRow {
  let toolInput: unknown = null;
  if (row.tool_input != null) {
    try {
      toolInput = JSON.parse(row.tool_input as string);
    } catch {
      toolInput = row.tool_input;
    }
  }
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    role: row.role as ChatRole,
    content: row.content as string,
    tool_name: (row.tool_name as string | null) ?? null,
    tool_input: toolInput,
    tool_output: (row.tool_output as string | null) ?? null,
    audio_path: (row.audio_path as string | null) ?? null,
    tts_path: (row.tts_path as string | null) ?? null,
    tokens_in: Number(row.tokens_in ?? 0),
    tokens_out: Number(row.tokens_out ?? 0),
    cost: Number(row.cost ?? 0),
    status: (row.status as ChatMessageStatus) ?? "complete",
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

const THREAD_SELECT = `
  SELECT
    t.*,
    (SELECT MAX(created_at) FROM messages m WHERE m.thread_id = t.id) AS last_message_at,
    (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
  FROM threads t
`;

export function createThread(input: ThreadInsert): ThreadRow {
  const db = getDb();
  const source = input.source ?? "web";
  const sourceSessionId = input.source_session_id ?? null;

  if (sourceSessionId) {
    const existing = getThreadBySource(source, sourceSessionId);
    if (existing) {
      return updateThread(existing.id, {
        title: input.title?.trim() || existing.title,
        agentId: input.agent_id,
        metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      })!;
    }
  }

  const id = input.id ?? randomUUID();
  const title = (input.title?.trim() || "Nova conversa").slice(0, 200);

  db.prepare(
    `INSERT INTO threads (
        id, title, agent_id, workspace, source, source_session_id, metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    input.agent_id,
    input.workspace ?? null,
    source,
    sourceSessionId,
    JSON.stringify(input.metadata ?? {}),
  );

  return getThread(id)!;
}

export function getThread(id: string): ThreadRow | null {
  const db = getDb();
  const row = db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? parseThread(row) : null;
}

export function getThreadBySource(
  source: ChatSource,
  sourceSessionId: string | null,
): ThreadRow | null {
  if (!sourceSessionId) return null;
  const db = getDb();
  const row = db
    .prepare(`${THREAD_SELECT} WHERE t.source = ? AND t.source_session_id = ?`)
    .get(source, sourceSessionId) as Record<string, unknown> | undefined;
  return row ? parseThread(row) : null;
}

export interface ListThreadsOptions {
  agentId?: string;
  archived?: boolean;
  pinned?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
  /** Sources to omit from the result (e.g. "worker" task-execution threads
   * that belong on the missions board, not the chat sidebar). */
  excludeSources?: ChatSource[];
}

export function listThreads(opts: ListThreadsOptions = {}): ThreadRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.agentId) {
    where.push("t.agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.archived !== undefined) {
    where.push("t.archived = ?");
    params.push(opts.archived ? 1 : 0);
  } else {
    where.push("t.archived = 0");
  }
  if (opts.pinned !== undefined) {
    where.push("t.pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.search) {
    where.push("(t.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.content LIKE ?))");
    const term = `%${opts.search}%`;
    params.push(term, term);
  }
  if (opts.excludeSources && opts.excludeSources.length > 0) {
    where.push(`t.source NOT IN (${opts.excludeSources.map(() => "?").join(", ")})`);
    params.push(...opts.excludeSources);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = db
    .prepare(
      `${THREAD_SELECT}
       ${whereSql}
       ORDER BY t.pinned DESC, COALESCE(last_message_at, t.updated_at) DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(parseThread);
}

export interface UpdateThreadInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  metadata?: Record<string, unknown>;
  agentId?: string;
  source_session_id?: string;
}

export function updateThread(id: string, patch: UpdateThreadInput): ThreadRow | null {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title.slice(0, 200));
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    sets.push("archived = ?");
    params.push(patch.archived ? 1 : 0);
  }
  if (patch.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(JSON.stringify(patch.metadata));
  }
  if (patch.agentId !== undefined) {
    sets.push("agent_id = ?");
    params.push(patch.agentId);
  }
  if (patch.source_session_id !== undefined) {
    sets.push("source_session_id = ?");
    params.push(patch.source_session_id);
  }

  if (sets.length === 0) return getThread(id);
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return getThread(id);
}

export function deleteThread(id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  return res.changes > 0;
}

export function appendMessage(input: MessageInsert): MessageRow {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const toolInput =
    input.tool_input === undefined || input.tool_input === null
      ? null
      : typeof input.tool_input === "string"
      ? input.tool_input
      : JSON.stringify(input.tool_input);

  db.prepare(
    `INSERT INTO messages (
        id, thread_id, role, content, tool_name, tool_input, tool_output,
        audio_path, tts_path, tokens_in, tokens_out, cost, status, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.thread_id,
    input.role,
    input.content,
    input.tool_name ?? null,
    toolInput,
    input.tool_output ?? null,
    input.audio_path ?? null,
    input.tts_path ?? null,
    input.tokens_in ?? 0,
    input.tokens_out ?? 0,
    input.cost ?? 0,
    input.status ?? "complete",
    input.error ?? null,
  );

  db.prepare(`UPDATE threads SET updated_at = datetime('now') WHERE id = ?`).run(
    input.thread_id,
  );

  return getMessage(id)!;
}

export function getMessage(id: string): MessageRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? parseMessage(row) : null;
}

export interface UpdateMessageInput {
  content?: string;
  toolOutput?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  status?: ChatMessageStatus;
  error?: string | null;
  ttsPath?: string | null;
}

export function updateMessage(id: string, patch: UpdateMessageInput): MessageRow | null {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.content !== undefined) {
    sets.push("content = ?");
    params.push(patch.content);
  }
  if (patch.toolOutput !== undefined) {
    sets.push("tool_output = ?");
    params.push(patch.toolOutput);
  }
  if (patch.tokensIn !== undefined) {
    sets.push("tokens_in = ?");
    params.push(patch.tokensIn);
  }
  if (patch.tokensOut !== undefined) {
    sets.push("tokens_out = ?");
    params.push(patch.tokensOut);
  }
  if (patch.cost !== undefined) {
    sets.push("cost = ?");
    params.push(patch.cost);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  if (patch.ttsPath !== undefined) {
    sets.push("tts_path = ?");
    params.push(patch.ttsPath);
  }

  if (sets.length === 0) return getMessage(id);

  db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return getMessage(id);
}

export interface ListMessagesOptions {
  threadId: string;
  limit?: number;
  beforeCreatedAt?: string;
  afterCreatedAt?: string;
}

export function listMessages(opts: ListMessagesOptions): MessageRow[] {
  const db = getDb();
  const where: string[] = ["thread_id = ?"];
  const params: unknown[] = [opts.threadId];

  if (opts.beforeCreatedAt) {
    where.push("created_at < ?");
    params.push(opts.beforeCreatedAt);
  }
  if (opts.afterCreatedAt) {
    where.push("created_at > ?");
    params.push(opts.afterCreatedAt);
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];

  return rows.map(parseMessage);
}

export function deleteMessage(id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  return res.changes > 0;
}

export interface SearchHit {
  message: MessageRow;
  thread: ThreadRow;
  snippet: string;
}

export function searchMessages(query: string, limit = 50): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const db = getDb();

  const ftsQuery = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");

  const rows = db
    .prepare(
      `SELECT
         m.*,
         snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(ftsQuery, Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];

  const results: SearchHit[] = [];
  const threadCache = new Map<string, ThreadRow>();

  for (const row of rows) {
    const message = parseMessage(row);
    let thread = threadCache.get(message.thread_id);
    if (!thread) {
      const t = getThread(message.thread_id);
      if (!t) continue;
      thread = t;
      threadCache.set(message.thread_id, thread);
    }
    results.push({ message, thread, snippet: (row.snippet as string) ?? "" });
  }

  return results;
}

export interface ThreadStats {
  totalThreads: number;
  totalMessages: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
}

export function getThreadStats(): ThreadStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM threads WHERE archived = 0) AS total_threads,
         COUNT(*) AS total_messages,
         COALESCE(SUM(tokens_in), 0) AS total_tokens_in,
         COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
         COALESCE(SUM(cost), 0) AS total_cost
       FROM messages`,
    )
    .get() as Record<string, unknown>;

  return {
    totalThreads: Number(row.total_threads ?? 0),
    totalMessages: Number(row.total_messages ?? 0),
    totalTokensIn: Number(row.total_tokens_in ?? 0),
    totalTokensOut: Number(row.total_tokens_out ?? 0),
    totalCost: Number(row.total_cost ?? 0),
  };
}

export function getChatDbPath(): string {
  return DB_PATH;
}
