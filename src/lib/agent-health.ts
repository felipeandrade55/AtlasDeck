/**
 * Real-time agent health tracking — replaces the legacy "is online if
 * memory/<today>.md was modified in the last 5 minutes" heuristic with a
 * proper heartbeat + state machine. Powers the Office3D animations and the
 * Live Mission dashboard.
 *
 * State semantics:
 *   idle       — agent alive, no task assigned
 *   thinking   — task assigned, decomposing/planning (LLM-only, no tool use)
 *   working    — actively executing a task (tool calls in flight)
 *   delegating — orchestrator currently invoking delegate_to()
 *   reviewing  — orchestrator evaluating a sub-agent's result
 *   stuck      — heartbeat ageing past STUCK_THRESHOLD_MS while in a non-idle state
 *   offline    — heartbeat ageing past OFFLINE_THRESHOLD_MS
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { publishEvent } from "./live-events";

const DB_PATH = path.join(process.cwd(), "data", "tasks.db");

export type AgentState =
  | "idle"
  | "thinking"
  | "working"
  | "delegating"
  | "reviewing"
  | "stuck"
  | "offline";

export const AGENT_STATES: AgentState[] = [
  "idle",
  "thinking",
  "working",
  "delegating",
  "reviewing",
  "stuck",
  "offline",
];

/** A heartbeat older than this puts the agent in `stuck` (if non-idle) or `offline`. */
export const STUCK_THRESHOLD_MS = 60 * 1000; // 1 minute without heartbeat = stuck
export const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without heartbeat = offline

export interface AgentHealth {
  agent_id: string;
  last_heartbeat: string;
  current_task_id: string | null;
  state: AgentState;
  state_changed_at: string;
  metadata: Record<string, unknown> | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_health (
      agent_id TEXT PRIMARY KEY,
      last_heartbeat TEXT NOT NULL,
      current_task_id TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      state_changed_at TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_health_state ON agent_health(state);
  `);

  return _db;
}

function parseRow(row: Record<string, unknown>): AgentHealth {
  return {
    agent_id: row.agent_id as string,
    last_heartbeat: row.last_heartbeat as string,
    current_task_id: (row.current_task_id as string | null) ?? null,
    state: row.state as AgentState,
    state_changed_at: row.state_changed_at as string,
    metadata: row.metadata ? safeJson(row.metadata as string) : null,
  };
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface HeartbeatInput {
  agent_id: string;
  state?: AgentState;
  current_task_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Records a heartbeat. If `state` is provided and differs from current, the
 * state_changed_at marker is updated. Upserts on conflict.
 */
export function recordHeartbeat(input: HeartbeatInput): AgentHealth {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getHealth(input.agent_id);
  const nextState = input.state ?? existing?.state ?? "idle";
  const stateChanged = !existing || existing.state !== nextState;
  const stateChangedAt = stateChanged ? now : existing!.state_changed_at;

  db.prepare(`
    INSERT INTO agent_health (agent_id, last_heartbeat, current_task_id, state, state_changed_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      last_heartbeat = excluded.last_heartbeat,
      current_task_id = excluded.current_task_id,
      state = excluded.state,
      state_changed_at = excluded.state_changed_at,
      metadata = excluded.metadata
  `).run(
    input.agent_id,
    now,
    input.current_task_id ?? null,
    nextState,
    stateChangedAt,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  // State transitions are higher signal than raw heartbeats — split them so
  // the UI can filter (heartbeat = "alive ping", state_changed = real news).
  if (stateChanged) {
    publishEvent({
      event_type: "agent.state_changed",
      agent_id: input.agent_id,
      task_id: input.current_task_id ?? null,
      payload: {
        from: existing?.state ?? null,
        to: nextState,
      },
    });
  } else {
    publishEvent({
      event_type: "agent.heartbeat",
      agent_id: input.agent_id,
      task_id: input.current_task_id ?? null,
      payload: { state: nextState },
    });
  }

  return getHealth(input.agent_id)!;
}

/**
 * Reads stored health and reconciles against wall-clock thresholds. If the
 * heartbeat is older than OFFLINE_THRESHOLD_MS, returns the row with
 * state = "offline" (without mutating the DB — that's a separate sweep).
 * Stuck detection follows the same pattern.
 */
export function getHealth(agentId: string): AgentHealth | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_health WHERE agent_id = ?").get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const parsed = parseRow(row);
  return reconcile(parsed);
}

export function listHealth(): AgentHealth[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_health").all() as Record<string, unknown>[];
  return rows.map(parseRow).map(reconcile);
}

function reconcile(h: AgentHealth): AgentHealth {
  const age = Date.now() - new Date(h.last_heartbeat).getTime();
  if (age > OFFLINE_THRESHOLD_MS) return { ...h, state: "offline" };
  if (age > STUCK_THRESHOLD_MS && h.state !== "idle" && h.state !== "offline") {
    return { ...h, state: "stuck" };
  }
  return h;
}

/**
 * Idempotently writes the reconciled state back to disk. Called by a
 * housekeeping cron so the persisted state matches reality even between
 * heartbeats (so UIs polling without going through getHealth() get the
 * right answer).
 */
export function sweepStaleStates(): number {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_health").all() as Record<string, unknown>[];
  const stmt = db.prepare("UPDATE agent_health SET state = ? WHERE agent_id = ? AND state != ?");
  let changed = 0;
  for (const row of rows) {
    const parsed = parseRow(row);
    const reconciled = reconcile(parsed);
    if (reconciled.state !== parsed.state) {
      stmt.run(reconciled.state, parsed.agent_id, reconciled.state);
      changed++;
    }
  }
  return changed;
}

export function resetAgentState(agentId: string, state: AgentState = "idle"): AgentHealth | null {
  return recordHeartbeat({ agent_id: agentId, state, current_task_id: null });
}

export function deleteHealth(agentId: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM agent_health WHERE agent_id = ?").run(agentId);
  return info.changes > 0;
}
