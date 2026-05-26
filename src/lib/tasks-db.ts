/**
 * SQLite-backed task queue for multi-agent orchestration.
 *
 * Tasks flow through 7 statuses:
 *   planning → inbox → assigned → in_progress → testing → review → done
 * Plus failure states: failed, cancelled.
 *
 * A task can have a parent (delegated by an orchestrator) and a list of
 * dependencies (depends_on[]) to support DAG-shaped decomposition (Convoy
 * Mode in Mission-Control terms). The dispatcher only moves a task from
 * "inbox" to "assigned" once every entry in depends_on is marked "done".
 *
 * Companion tables: agent_mailbox (mailbox-db.ts), agent_health
 * (agent-health.ts), work_checkpoints (here, used for crash recovery).
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { publishEvent } from "./live-events";

const DB_PATH = path.join(process.cwd(), "data", "tasks.db");

export type TaskStatus =
  | "planning"
  | "inbox"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type ReviewVerdict = "approved" | "rejected" | "needs_revision";

export const TASK_STATUSES: TaskStatus[] = [
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "done",
  "failed",
  "cancelled",
];

export interface Task {
  id: string;
  parent_task_id: string | null;
  delegated_by: string | null;
  assigned_to: string | null;
  status: TaskStatus;
  title: string;
  prompt: string;
  result: string | null;
  review_verdict: ReviewVerdict | null;
  review_notes: string | null;
  user_approved: boolean | null; // null = pending, true = thumbs up, false = thumbs down
  user_feedback: string | null;
  cost_cents: number;
  tokens_in: number;
  tokens_out: number;
  depends_on: string[];
  workspace_path: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Checkpoint {
  id: string;
  task_id: string;
  agent_id: string;
  checkpoint_data: Record<string, unknown>;
  created_at: string;
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
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      delegated_by TEXT,
      assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      result TEXT,
      review_verdict TEXT,
      review_notes TEXT,
      user_approved INTEGER,
      user_feedback TEXT,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      depends_on TEXT NOT NULL DEFAULT '[]',
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

    CREATE TABLE IF NOT EXISTS work_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      checkpoint_data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON work_checkpoints(task_id, created_at DESC);
  `);

  return _db;
}

function parseRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    parent_task_id: (row.parent_task_id as string | null) ?? null,
    delegated_by: (row.delegated_by as string | null) ?? null,
    assigned_to: (row.assigned_to as string | null) ?? null,
    status: row.status as TaskStatus,
    title: (row.title as string) ?? "",
    prompt: row.prompt as string,
    result: (row.result as string | null) ?? null,
    review_verdict: (row.review_verdict as ReviewVerdict | null) ?? null,
    review_notes: (row.review_notes as string | null) ?? null,
    user_approved:
      row.user_approved === null || row.user_approved === undefined
        ? null
        : (row.user_approved as number) === 1,
    user_feedback: (row.user_feedback as string | null) ?? null,
    cost_cents: (row.cost_cents as number) ?? 0,
    tokens_in: (row.tokens_in as number) ?? 0,
    tokens_out: (row.tokens_out as number) ?? 0,
    depends_on: row.depends_on ? safeJson<string[]>(row.depends_on as string, []) : [],
    workspace_path: (row.workspace_path as string | null) ?? null,
    created_at: row.created_at as string,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    metadata: row.metadata ? safeJson<Record<string, unknown>>(row.metadata as string, {}) : null,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface CreateTaskInput {
  parent_task_id?: string | null;
  delegated_by?: string | null;
  assigned_to?: string | null;
  status?: TaskStatus;
  title?: string;
  prompt: string;
  depends_on?: string[];
  workspace_path?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "inbox";

  db.prepare(`
    INSERT INTO tasks (
      id, parent_task_id, delegated_by, assigned_to, status, title, prompt,
      depends_on, workspace_path, created_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.parent_task_id ?? null,
    input.delegated_by ?? null,
    input.assigned_to ?? null,
    status,
    input.title ?? "",
    input.prompt,
    JSON.stringify(input.depends_on ?? []),
    input.workspace_path ?? null,
    now,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  const task = getTaskById(id)!;
  publishEvent({
    event_type: "task.created",
    task_id: task.id,
    agent_id: task.assigned_to,
    payload: {
      title: task.title,
      status: task.status,
      parent_task_id: task.parent_task_id,
      delegated_by: task.delegated_by,
      depends_on: task.depends_on,
    },
  });
  return task;
}

export function getTaskById(id: string): Task | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  assigned_to?: string;
  delegated_by?: string;
  parent_task_id?: string | null; // null = root tasks only
  limit?: number;
  offset?: number;
  sort?: "newest" | "oldest";
}

export function listTasks(opts: ListTasksOptions = {}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (opts.assigned_to) {
    conditions.push("assigned_to = ?");
    params.push(opts.assigned_to);
  }
  if (opts.delegated_by) {
    conditions.push("delegated_by = ?");
    params.push(opts.delegated_by);
  }
  if (opts.parent_task_id === null) {
    conditions.push("parent_task_id IS NULL");
  } else if (typeof opts.parent_task_id === "string") {
    conditions.push("parent_task_id = ?");
    params.push(opts.parent_task_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = opts.sort === "oldest" ? "ASC" : "DESC";
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(parseRow);
}

export function listChildren(parentId: string): Task[] {
  return listTasks({ parent_task_id: parentId, sort: "oldest", limit: 500 });
}

/**
 * Returns dispatchable subtasks of a parent: those still in "inbox" whose
 * depends_on entries are all in status "done". Used by the dispatcher to
 * pick the next batch of work in a DAG.
 */
export function getDispatchableChildren(parentId: string): Task[] {
  const all = listChildren(parentId);
  const doneIds = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
  return all.filter(
    (t) => t.status === "inbox" && t.depends_on.every((dep) => doneIds.has(dep)),
  );
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  assigned_to?: string | null;
  title?: string;
  result?: string | null;
  review_verdict?: ReviewVerdict | null;
  review_notes?: string | null;
  user_approved?: boolean | null;
  user_feedback?: string | null;
  cost_cents?: number;
  tokens_in?: number;
  tokens_out?: number;
  workspace_path?: string | null;
  metadata?: Record<string, unknown> | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export function updateTask(id: string, patch: UpdateTaskInput): Task | null {
  const db = getDb();
  const existing = getTaskById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  function set(col: string, val: unknown) {
    sets.push(`${col} = ?`);
    params.push(val);
  }

  if (patch.status !== undefined) {
    set("status", patch.status);
    // Auto-stamp transitions
    if (patch.status === "in_progress" && !existing.started_at) {
      set("started_at", new Date().toISOString());
    }
    if (
      (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") &&
      !existing.completed_at
    ) {
      set("completed_at", new Date().toISOString());
    }
  }
  if (patch.assigned_to !== undefined) set("assigned_to", patch.assigned_to);
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.result !== undefined) set("result", patch.result);
  if (patch.review_verdict !== undefined) set("review_verdict", patch.review_verdict);
  if (patch.review_notes !== undefined) set("review_notes", patch.review_notes);
  if (patch.user_approved !== undefined) {
    set("user_approved", patch.user_approved === null ? null : patch.user_approved ? 1 : 0);
  }
  if (patch.user_feedback !== undefined) set("user_feedback", patch.user_feedback);
  if (patch.cost_cents !== undefined) set("cost_cents", patch.cost_cents);
  if (patch.tokens_in !== undefined) set("tokens_in", patch.tokens_in);
  if (patch.tokens_out !== undefined) set("tokens_out", patch.tokens_out);
  if (patch.workspace_path !== undefined) set("workspace_path", patch.workspace_path);
  if (patch.metadata !== undefined) {
    set("metadata", patch.metadata === null ? null : JSON.stringify(patch.metadata));
  }
  if (patch.started_at !== undefined) set("started_at", patch.started_at);
  if (patch.completed_at !== undefined) set("completed_at", patch.completed_at);

  if (sets.length === 0) return existing;

  params.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  const updated = getTaskById(id);

  // Surface status transitions to the live stream so the kanban / activity
  // feed redraws without having to poll.
  if (updated && patch.status !== undefined && patch.status !== existing.status) {
    publishEvent({
      event_type: "task.status_changed",
      task_id: id,
      agent_id: updated.assigned_to,
      payload: {
        from: existing.status,
        to: updated.status,
        title: updated.title,
      },
    });
  }
  // Treat review_verdict / user_approved transitions as first-class events
  // too — they drive the approval inbox without needing extra polling.
  if (updated && patch.review_verdict !== undefined && patch.review_verdict !== existing.review_verdict) {
    publishEvent({
      event_type: "task.reviewed",
      task_id: id,
      agent_id: updated.assigned_to,
      payload: { verdict: patch.review_verdict, notes: updated.review_notes },
    });
  }
  if (updated && patch.user_approved !== undefined && patch.user_approved !== existing.user_approved) {
    publishEvent({
      event_type: "task.approved",
      task_id: id,
      agent_id: updated.assigned_to,
      payload: {
        approved: patch.user_approved,
        feedback: updated.user_feedback,
      },
    });
  }

  return updated;
}

/**
 * Incremental cost/token accumulator — adds to existing totals rather than
 * overwriting, so multiple checkpoint reports compose correctly.
 */
export function addTaskUsage(id: string, delta: {
  cost_cents?: number;
  tokens_in?: number;
  tokens_out?: number;
}): Task | null {
  const db = getDb();
  const existing = getTaskById(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE tasks SET
      cost_cents = cost_cents + ?,
      tokens_in = tokens_in + ?,
      tokens_out = tokens_out + ?
    WHERE id = ?
  `).run(delta.cost_cents ?? 0, delta.tokens_in ?? 0, delta.tokens_out ?? 0, id);
  return getTaskById(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return info.changes > 0;
}

/* -------------------- checkpoints -------------------- */

export function createCheckpoint(taskId: string, agentId: string, data: Record<string, unknown>): Checkpoint {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_checkpoints (id, task_id, agent_id, checkpoint_data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, taskId, agentId, JSON.stringify(data), now);
  publishEvent({
    event_type: "task.checkpoint",
    task_id: taskId,
    agent_id: agentId,
    payload: { checkpoint_id: id, data },
  });
  return { id, task_id: taskId, agent_id: agentId, checkpoint_data: data, created_at: now };
}

export function listCheckpoints(taskId: string, limit = 50): Checkpoint[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM work_checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(taskId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    task_id: r.task_id as string,
    agent_id: r.agent_id as string,
    checkpoint_data: safeJson<Record<string, unknown>>(r.checkpoint_data as string, {}),
    created_at: r.created_at as string,
  }));
}

export function getLatestCheckpoint(taskId: string): Checkpoint | null {
  return listCheckpoints(taskId, 1)[0] ?? null;
}

/* -------------------- stats -------------------- */

export interface TaskStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  inFlight: number;
  costCentsToday: number;
}

export function getTaskStats(): TaskStats {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n;
  const byStatusRows = db
    .prepare("SELECT status, COUNT(*) as n FROM tasks GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const r of byStatusRows) {
    if (r.status in byStatus) byStatus[r.status as TaskStatus] = r.n;
  }
  const inFlight =
    byStatus.planning + byStatus.assigned + byStatus.in_progress + byStatus.testing + byStatus.review;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const costCentsToday =
    (db
      .prepare("SELECT SUM(cost_cents) as n FROM tasks WHERE created_at >= ?")
      .get(todayStart.toISOString()) as { n: number | null }).n ?? 0;

  return { total, byStatus, inFlight, costCentsToday };
}

/**
 * Total cost spent today by a specific agent (used by cost-cap enforcement
 * before allowing the dispatcher to assign a new task to that agent).
 */
export function getAgentCostToday(agentId: string): number {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = db
    .prepare("SELECT SUM(cost_cents) as n FROM tasks WHERE assigned_to = ? AND created_at >= ?")
    .get(agentId, todayStart.toISOString()) as { n: number | null };
  return row.n ?? 0;
}
