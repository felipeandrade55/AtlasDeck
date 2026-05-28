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
  `);

  globalRef.__atlasdeckRemindersDb = db;
  return db;
}

function rowToReminder(row: any): Reminder {
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    due_at: row.due_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
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
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
  return row ? rowToReminder(row) : null;
}

export function listAllReminders(): Reminder[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM reminders ORDER BY created_at DESC`).all();
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
