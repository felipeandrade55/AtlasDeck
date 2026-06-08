import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

export interface Note {
  id: string;
  title: string;
  content: string;
  color: string;
  pinned: boolean;
  is_quick: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteInput {
  id?: string;
  title?: string;
  content?: string;
  color?: string;
  pinned?: boolean;
}

const QUICK_NOTE_ID = "quick-note";

const DB_PATH = path.join(process.cwd(), "data", "notes.db");

type NotesGlobal = typeof globalThis & {
  __atlasdeckNotesDb?: Database.Database;
};

const globalRef = globalThis as NotesGlobal;

function getDb(): Database.Database {
  if (globalRef.__atlasdeckNotesDb) return globalRef.__atlasdeckNotesDb;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'default',
      pinned INTEGER NOT NULL DEFAULT 0,
      is_quick INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
  `);

  globalRef.__atlasdeckNotesDb = db;
  return db;
}

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: row.id as string,
    title: (row.title as string) ?? "",
    content: (row.content as string) ?? "",
    color: (row.color as string) || "default",
    pinned: !!row.pinned,
    is_quick: !!row.is_quick,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createNote(input: NoteInput): Note {
  const db = getDb();
  const id = input.id || randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO notes (id, title, content, color, pinned, is_quick, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    input.title ?? "",
    input.content ?? "",
    input.color ?? "default",
    input.pinned ? 1 : 0,
    now,
    now
  );

  return getNoteById(id)!;
}

export function getNoteById(id: string): Note | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToNote(row) : null;
}

export function listAllNotes(search?: string | null): Note[] {
  const db = getDb();
  const term = search?.trim();
  if (term) {
    const like = `%${term}%`;
    const rows = db
      .prepare(
        `SELECT * FROM notes
         WHERE title LIKE ? OR content LIKE ?
         ORDER BY pinned DESC, updated_at DESC`
      )
      .all(like, like) as Record<string, unknown>[];
    return rows.map(rowToNote);
  }
  const rows = db
    .prepare(`SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToNote);
}

export function updateNote(id: string, patch: NoteInput): Note | null {
  const db = getDb();
  const existing = getNoteById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notes SET
      title = COALESCE(?, title),
      content = COALESCE(?, content),
      color = COALESCE(?, color),
      pinned = COALESCE(?, pinned),
      updated_at = ?
     WHERE id = ?`
  ).run(
    patch.title ?? null,
    patch.content ?? null,
    patch.color ?? null,
    patch.pinned === undefined ? null : patch.pinned ? 1 : 0,
    now,
    id
  );

  return getNoteById(id);
}

export function deleteNote(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getQuickNote(): Note | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM notes WHERE is_quick = 1 LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? rowToNote(row) : null;
}

export function upsertQuickNote(content: string): Note {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getQuickNote();

  if (existing) {
    db.prepare(
      `UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`
    ).run(content, now, existing.id);
    return getNoteById(existing.id)!;
  }

  db.prepare(
    `INSERT INTO notes (id, title, content, color, pinned, is_quick, created_at, updated_at)
     VALUES (?, '', ?, 'default', 0, 1, ?, ?)`
  ).run(QUICK_NOTE_ID, content, now, now);

  return getNoteById(QUICK_NOTE_ID)!;
}
