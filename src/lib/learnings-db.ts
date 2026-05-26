/**
 * The preference model's persistent state — small SQLite table colocated
 * in tasks.db so the dispatcher and the orchestrator-tools both reach it
 * without juggling another connection.
 *
 * A "learning" is one observation about the user's preferences, scoped to
 * either a specific agent (e.g. "user prefers minimal comments from dev")
 * or global ("user dislikes long preambles"). Each one carries:
 *   - source: where the evidence came from (approval/feedback/sentiment)
 *   - confidence: 0..1, raised by repeated reinforcement
 *   - evidence: short raw quote / task id so we can audit later
 *
 * The Learner Agent (Fase 4) consolidates clusters of related learnings
 * and patches the affected specialists' system prompts.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.cwd(), "data", "tasks.db");

export type LearningSource = "approval" | "rejection" | "feedback_text" | "implicit_sentiment" | "manual";

export interface Learning {
  id: string;
  agent_id: string | null; // null = global learning
  pattern: string; // human-readable rule ("usuário prefere X")
  evidence: string | null; // raw quote / task id
  source: LearningSource;
  confidence: number; // 0..1
  refuted: boolean; // user marked as wrong
  created_at: string;
  last_seen_at: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      pattern TEXT NOT NULL,
      evidence TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      refuted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_agent ON learnings(agent_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_source ON learnings(source);
    CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence DESC);
  `);

  return _db;
}

function parseRow(row: Record<string, unknown>): Learning {
  return {
    id: row.id as string,
    agent_id: (row.agent_id as string | null) ?? null,
    pattern: row.pattern as string,
    evidence: (row.evidence as string | null) ?? null,
    source: row.source as LearningSource,
    confidence: row.confidence as number,
    refuted: (row.refuted as number) === 1,
    created_at: row.created_at as string,
    last_seen_at: row.last_seen_at as string,
  };
}

export interface RecordLearningInput {
  agent_id?: string | null;
  pattern: string;
  evidence?: string | null;
  source: LearningSource;
  confidence?: number;
}

/**
 * Idempotently records a learning. If a matching (agent_id + pattern) row
 * already exists, bumps its confidence toward 1 and refreshes last_seen_at
 * — repeated evidence strengthens the signal rather than fragmenting it.
 */
export function recordLearning(input: RecordLearningInput): Learning {
  const db = getDb();
  const now = new Date().toISOString();
  const agentId = input.agent_id ?? null;

  // Look for an existing learning with the same (agent_id, pattern).
  const existing = db
    .prepare(
      "SELECT * FROM learnings WHERE pattern = ? AND ((agent_id IS NULL AND ? IS NULL) OR agent_id = ?)",
    )
    .get(input.pattern, agentId, agentId) as Record<string, unknown> | undefined;

  if (existing) {
    const current = parseRow(existing);
    const bumped = Math.min(1, current.confidence + (input.confidence ?? 0.15));
    db.prepare(
      "UPDATE learnings SET confidence = ?, last_seen_at = ?, evidence = COALESCE(?, evidence), source = ?, refuted = 0 WHERE id = ?",
    ).run(bumped, now, input.evidence ?? null, input.source, current.id);
    return parseRow(
      db.prepare("SELECT * FROM learnings WHERE id = ?").get(current.id) as Record<string, unknown>,
    );
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO learnings (id, agent_id, pattern, evidence, source, confidence, refuted, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    agentId,
    input.pattern,
    input.evidence ?? null,
    input.source,
    input.confidence ?? 0.5,
    now,
    now,
  );
  return parseRow(
    db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export interface ListLearningsOptions {
  agent_id?: string | null;
  include_refuted?: boolean;
  min_confidence?: number;
  limit?: number;
}

export function listLearnings(opts: ListLearningsOptions = {}): Learning[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.agent_id !== undefined) {
    if (opts.agent_id === null) {
      conditions.push("agent_id IS NULL");
    } else {
      conditions.push("(agent_id = ? OR agent_id IS NULL)");
      params.push(opts.agent_id);
    }
  }
  if (!opts.include_refuted) conditions.push("refuted = 0");
  if (typeof opts.min_confidence === "number") {
    conditions.push("confidence >= ?");
    params.push(opts.min_confidence);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare(`SELECT * FROM learnings ${where} ORDER BY confidence DESC, last_seen_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(parseRow);
}

export function refuteLearning(id: string): Learning | null {
  const db = getDb();
  db.prepare("UPDATE learnings SET refuted = 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? parseRow(row) : null;
}

export function deleteLearning(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM learnings WHERE id = ?").run(id);
  return info.changes > 0;
}
