/**
 * Live event bus for the multi-agent dashboard. Two layers:
 *
 *   1. In-process EventEmitter — what active SSE connections subscribe to.
 *      Zero latency, but bound to one Node worker.
 *   2. SQLite `live_events` table — durable log used (a) to replay the
 *      most recent N events on SSE connect and (b) as a fallback for other
 *      workers that didn't receive the in-memory emit.
 *
 * Publishers (tasks-db, mailbox-db, agent-health) call publishEvent() which
 * writes to SQLite first (atomic, fault-tolerant) and then fires the
 * emitter. SSE consumers attach to the emitter and reconnect-replay from
 * SQLite using the `since` cursor (event id is monotonic enough via TEXT
 * sort of ISO timestamps + UUID tie-break).
 */
import { EventEmitter } from "events";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.cwd(), "data", "tasks.db");

export type LiveEventType =
  | "task.created"
  | "task.delegated"
  | "task.status_changed"
  | "task.checkpoint"
  | "task.completed"
  | "task.reviewed"
  | "task.approved"
  | "mailbox.message"
  | "agent.heartbeat"
  | "agent.state_changed"
  | "dispatcher.run"
  | "chat.turn_started"
  | "chat.tool_use"
  | "chat.turn_completed"
  // Pentest module — run/phase/tool/finding lifecycle. task_id carries the
  // pentest run_id so the SSE stream can filter a single run.
  | "pentest.run_started"
  | "pentest.phase_started"
  | "pentest.phase_completed"
  | "pentest.tool_started"
  | "pentest.tool_output"
  | "pentest.tool_progress"
  | "pentest.tool_completed"
  | "pentest.finding"
  | "pentest.run_completed"
  | "pentest.run_failed";

export interface LiveEvent {
  id: string;
  event_type: LiveEventType;
  task_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

let _db: Database.Database | null = null;
const emitter = new EventEmitter();
// SSE connections fan out fast in dev (HMR re-mounts), bump the cap so
// Node doesn't print MaxListenersExceededWarning during local testing.
emitter.setMaxListeners(50);

function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS live_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_events_time ON live_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_live_events_type ON live_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_live_events_task ON live_events(task_id);
  `);
  return _db;
}

function parseRow(row: Record<string, unknown>): LiveEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload as string);
  } catch {}
  return {
    id: row.id as string,
    event_type: row.event_type as LiveEventType,
    task_id: (row.task_id as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    payload,
    created_at: row.created_at as string,
  };
}

export interface PublishInput {
  event_type: LiveEventType;
  task_id?: string | null;
  agent_id?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Persist the event in SQLite, then fan out via the in-process emitter.
 * Best-effort — failure to insert does NOT propagate (live events are
 * observability, not source-of-truth state).
 */
export function publishEvent(input: PublishInput): LiveEvent | null {
  try {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const payload = input.payload ?? {};
    db.prepare(`
      INSERT INTO live_events (id, event_type, task_id, agent_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.event_type,
      input.task_id ?? null,
      input.agent_id ?? null,
      JSON.stringify(payload),
      now,
    );
    const event: LiveEvent = {
      id,
      event_type: input.event_type,
      task_id: input.task_id ?? null,
      agent_id: input.agent_id ?? null,
      payload,
      created_at: now,
    };
    emitter.emit("event", event);
    // Opportunistic prune: drop everything older than 24h once every ~256
    // emits (cheap heuristic to keep the table bounded without a cron).
    if (Math.random() < 1 / 256) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM live_events WHERE created_at < ?").run(cutoff);
    }
    return event;
  } catch (e) {
    if (process.env.LIVE_EVENTS_DEBUG === "1") {
      console.warn("[live-events] publish failed:", e);
    }
    return null;
  }
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribe(handler: (event: LiveEvent) => void): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}

export interface ListEventsOptions {
  since?: string; // ISO timestamp or event id (we accept either; cmp on created_at)
  limit?: number;
  event_types?: LiveEventType[];
  task_id?: string;
  agent_id?: string;
}

export function listEvents(opts: ListEventsOptions = {}): LiveEvent[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    conditions.push("created_at > ?");
    params.push(opts.since);
  }
  if (opts.event_types?.length) {
    conditions.push(`event_type IN (${opts.event_types.map(() => "?").join(",")})`);
    params.push(...opts.event_types);
  }
  if (opts.task_id) {
    conditions.push("task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.agent_id) {
    conditions.push("agent_id = ?");
    params.push(opts.agent_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const rows = db
    .prepare(`SELECT * FROM live_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(parseRow).reverse(); // oldest first so the client can replay in order
}
