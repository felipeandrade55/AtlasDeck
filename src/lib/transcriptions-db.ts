/**
 * SQLite storage for audio transcriptions (meetings, notes).
 *
 * A transcription is a session that accumulates text from sequential audio
 * chunks transcribed by OpenAI. After the user stops, it is analyzed
 * (summary + key points + suggested calendar events) and pushed into memory.
 *
 * FTS5 mirror powers full-text retrieval — used by the MCP tools so OpenClaw
 * (e.g. via Telegram) can search transcripts and talk about them as a
 * knowledge base.
 *
 * Singleton guarded by globalThis to survive dev HMR (same pattern as
 * calendar-db.ts).
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.cwd(), "data", "transcriptions.db");

export type TranscriptionStatus =
  | "recording"
  | "analyzing"
  | "analyzed"
  | "error";

export interface Transcription {
  id: string;
  title: string;
  status: TranscriptionStatus;
  language: string;
  text: string;
  summary: string | null;
  key_points: string[];
  duration_ms: number | null;
  memory_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

type TxGlobal = typeof globalThis & {
  __atlasdeckTranscriptionsDb?: Database.Database;
};
const globalRef = globalThis as TxGlobal;

function getDb(): Database.Database {
  if (globalRef.__atlasdeckTranscriptionsDb) return globalRef.__atlasdeckTranscriptionsDb;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      language TEXT NOT NULL DEFAULT 'pt',
      text TEXT NOT NULL DEFAULT '',
      summary TEXT,
      key_points TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER,
      memory_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_status ON transcriptions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transcriptions(created_at DESC);

    CREATE TABLE IF NOT EXISTS transcription_chunks (
      transcription_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (transcription_id, seq),
      FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS transcriptions_fts USING fts5(
      id UNINDEXED,
      title,
      summary,
      text
    );
  `);

  globalRef.__atlasdeckTranscriptionsDb = db;
  return db;
}

function rowToTranscription(row: Record<string, unknown>): Transcription {
  let keyPoints: string[] = [];
  try {
    const parsed = JSON.parse((row.key_points as string) || "[]");
    if (Array.isArray(parsed)) keyPoints = parsed.map(String);
  } catch {
    keyPoints = [];
  }
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as TranscriptionStatus,
    language: row.language as string,
    text: (row.text as string) ?? "",
    summary: (row.summary as string | null) ?? null,
    key_points: keyPoints,
    duration_ms: (row.duration_ms as number | null) ?? null,
    memory_id: (row.memory_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createTranscription(input: { title?: string; language?: string }): Transcription {
  const db = getDb();
  const id = randomUUID();
  const title = (input.title || "").trim() || defaultTitle();
  db.prepare(
    `INSERT INTO transcriptions (id, title, status, language) VALUES (?, ?, 'recording', ?)`
  ).run(id, title, input.language || "pt");
  return getTranscription(id)!;
}

function defaultTitle(): string {
  const now = new Date();
  const d = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const t = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `Transcrição ${d} ${t}`;
}

export function getTranscription(id: string): Transcription | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM transcriptions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTranscription(row) : null;
}

export function listTranscriptions(limit = 100): Transcription[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTranscription);
}

/**
 * Append a transcribed chunk. Idempotent per (id, seq): re-sending the same
 * seq replaces it (safe for retries). The denormalized `text` is rebuilt
 * from all chunks ordered by seq.
 */
export function appendChunk(transcriptionId: string, seq: number, text: string): Transcription | null {
  const db = getDb();
  const existing = getTranscription(transcriptionId);
  if (!existing) return null;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO transcription_chunks (transcription_id, seq, text) VALUES (?, ?, ?)`
    ).run(transcriptionId, seq, text);
    const rows = db
      .prepare(`SELECT text FROM transcription_chunks WHERE transcription_id = ? ORDER BY seq ASC`)
      .all(transcriptionId) as Array<{ text: string }>;
    const full = rows.map((r) => r.text.trim()).filter(Boolean).join(" ");
    db.prepare(`UPDATE transcriptions SET text = ?, updated_at = datetime('now') WHERE id = ?`).run(
      full,
      transcriptionId
    );
  });
  tx();
  return getTranscription(transcriptionId);
}

export function updateTranscription(
  id: string,
  patch: {
    title?: string;
    status?: TranscriptionStatus;
    summary?: string | null;
    key_points?: string[];
    duration_ms?: number | null;
    memory_id?: string | null;
    error?: string | null;
  }
): Transcription | null {
  const db = getDb();
  const existing = getTranscription(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE transcriptions SET
       title = COALESCE(?, title),
       status = COALESCE(?, status),
       summary = COALESCE(?, summary),
       key_points = COALESCE(?, key_points),
       duration_ms = COALESCE(?, duration_ms),
       memory_id = COALESCE(?, memory_id),
       error = COALESCE(?, error),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    patch.title ?? null,
    patch.status ?? null,
    patch.summary === undefined ? null : patch.summary,
    patch.key_points ? JSON.stringify(patch.key_points) : null,
    patch.duration_ms ?? null,
    patch.memory_id ?? null,
    patch.error === undefined ? null : patch.error,
    id
  );
  const updated = getTranscription(id);
  if (updated) syncFts(updated);
  return updated;
}

export function deleteTranscription(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM transcriptions_fts WHERE id = ?`).run(id);
    const res = db.prepare(`DELETE FROM transcriptions WHERE id = ?`).run(id);
    return res.changes > 0;
  });
  return tx();
}

/** Rebuild the FTS row for one transcription (delete + insert). */
function syncFts(t: Transcription): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM transcriptions_fts WHERE id = ?`).run(t.id);
    db.prepare(
      `INSERT INTO transcriptions_fts (id, title, summary, text) VALUES (?, ?, ?, ?)`
    ).run(t.id, t.title, t.summary ?? "", t.text);
  });
  tx();
}

export interface TranscriptionSearchHit {
  id: string;
  title: string;
  summary: string | null;
  snippet: string;
  created_at: string;
}

/** Full-text search over transcriptions (FTS5, with LIKE fallback). */
export function searchTranscriptions(query: string, limit = 10): TranscriptionSearchHit[] {
  const db = getDb();
  const q = query.trim();
  if (!q) return [];
  try {
    const rows = db
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.summary AS summary, t.created_at AS created_at,
                snippet(transcriptions_fts, 3, '[', ']', '…', 12) AS snippet
         FROM transcriptions_fts f
         JOIN transcriptions t ON t.id = f.id
         WHERE transcriptions_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery(q), limit) as Array<{
      id: string;
      title: string;
      summary: string | null;
      created_at: string;
      snippet: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary ?? null,
      snippet: r.snippet ?? "",
      created_at: r.created_at,
    }));
  } catch {
    // Fallback: LIKE over the denormalized text.
    const like = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT id, title, summary, created_at, substr(text, 1, 200) AS snippet
         FROM transcriptions
         WHERE text LIKE ? OR title LIKE ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, like, limit) as Array<{
      id: string;
      title: string;
      summary: string | null;
      created_at: string;
      snippet: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary ?? null,
      snippet: r.snippet ?? "",
      created_at: r.created_at,
    }));
  }
}

/** Turn a free-text query into a safe FTS5 MATCH expression (OR of terms). */
function ftsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .replace(/["'()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" OR ") : `"${q.replace(/"/g, "")}"`;
}
