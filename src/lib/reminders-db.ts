import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

export interface Reminder {
  id: string;
  text: string;
  completed: boolean;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  id?: string;
  text: string;
  completed?: boolean;
  due_at?: string | null;
}

export type SuggestedTaskStatus = "pending" | "approved" | "rejected";

export interface SuggestedTask {
  id: string;
  transcription_id: string;
  task: string;
  owner: string | null;
  due_date: string | null;
  priority: string | null;
  source_text: string | null;
  confidence: number;
  status: SuggestedTaskStatus;
  reminder_id: string | null;
  created_at: string;
}

export interface SuggestedTaskInput {
  id?: string;
  transcription_id: string;
  task: string;
  owner?: string | null;
  due_date?: string | null;
  priority?: string | null;
  source_text?: string | null;
  confidence?: number;
}

const DB_PATH = path.join(process.cwd(), "data", "reminders.db");

type RemindersGlobal = typeof globalThis & {
  __atlasdeckRemindersDb?: Database.Database;
};

const globalRef = globalThis as RemindersGlobal;

function getDb(): Database.Database {
  if (globalRef.__atlasdeckRemindersDb) return globalRef.__atlasdeckRemindersDb;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_completed ON reminders(completed);
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);

    CREATE TABLE IF NOT EXISTS suggested_tasks (
      id TEXT PRIMARY KEY,
      transcription_id TEXT NOT NULL,
      task TEXT NOT NULL,
      owner TEXT,
      due_date TEXT,
      priority TEXT,
      source_text TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sugtask_status ON suggested_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_sugtask_transcription ON suggested_tasks(transcription_id);
  `);

  globalRef.__atlasdeckRemindersDb = db;
  return db;
}

function rowToReminder(row: Record<string, unknown>): Reminder {
  return {
    id: row.id as string,
    text: row.text as string,
    completed: !!row.completed,
    due_at: (row.due_at as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createReminder(input: ReminderInput): Reminder {
  const db = getDb();
  const id = input.id || randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO reminders (id, text, completed, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.text,
    input.completed ? 1 : 0,
    input.due_at || null,
    now,
    now
  );

  return getReminderById(id)!;
}

export function getReminderById(id: string): Reminder | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToReminder(row) : null;
}

export function listAllReminders(): Reminder[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM reminders ORDER BY created_at DESC`).all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToReminder);
}

export function updateReminder(id: string, patch: Partial<ReminderInput>): Reminder | null {
  const db = getDb();
  const existing = getReminderById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE reminders SET
      text = COALESCE(?, text),
      completed = COALESCE(?, completed),
      due_at = CASE WHEN ? = 1 THEN ? ELSE due_at END,
      updated_at = ?
     WHERE id = ?`
  ).run(
    patch.text ?? null,
    patch.completed === undefined ? null : patch.completed ? 1 : 0,
    "due_at" in patch ? 1 : 0,
    patch.due_at || null,
    now,
    id
  );

  return getReminderById(id);
}

export function deleteReminder(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ── Suggested tasks (action items extracted from transcriptions) ──────────
// Approval queue mirroring suggested_events: a pending task becomes a reminder
// when approved. Lives here (reminders.db) so approve runs in one local DB.

function rowToSuggestedTask(row: Record<string, unknown>): SuggestedTask {
  return {
    id: row.id as string,
    transcription_id: row.transcription_id as string,
    task: row.task as string,
    owner: (row.owner as string) ?? null,
    due_date: (row.due_date as string) ?? null,
    priority: (row.priority as string) ?? null,
    source_text: (row.source_text as string) ?? null,
    confidence: typeof row.confidence === "number" ? row.confidence : 0.5,
    status: row.status as SuggestedTaskStatus,
    reminder_id: (row.reminder_id as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function insertSuggestedTask(input: SuggestedTaskInput): SuggestedTask {
  const db = getDb();
  const id = input.id || randomUUID();
  db.prepare(
    `INSERT INTO suggested_tasks
       (id, transcription_id, task, owner, due_date, priority, source_text, confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    id,
    input.transcription_id,
    input.task,
    input.owner ?? null,
    input.due_date ?? null,
    input.priority ?? null,
    input.source_text ?? null,
    input.confidence ?? 0.5
  );
  return getSuggestedTaskById(id)!;
}

export function getSuggestedTaskById(id: string): SuggestedTask | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM suggested_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSuggestedTask(row) : null;
}

export function listSuggestedTasks(opts?: {
  status?: SuggestedTaskStatus;
  transcriptionId?: string;
}): SuggestedTask[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.transcriptionId) {
    where.push("transcription_id = ?");
    params.push(opts.transcriptionId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM suggested_tasks ${clause} ORDER BY created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToSuggestedTask);
}

export function updateSuggestedTask(
  id: string,
  patch: { status?: SuggestedTaskStatus; reminder_id?: string | null }
): SuggestedTask | null {
  const db = getDb();
  const existing = getSuggestedTaskById(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE suggested_tasks SET
       status = COALESCE(?, status),
       reminder_id = COALESCE(?, reminder_id)
     WHERE id = ?`
  ).run(patch.status ?? null, patch.reminder_id ?? null, id);
  return getSuggestedTaskById(id);
}
