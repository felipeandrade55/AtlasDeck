/**
 * In-process scheduler for the Learner Agent (Fase 4).
 *
 * Job: scan recently-approved/rejected tasks and run them through the
 * preference model, persisting learnings that the orchestrator-injector
 * will later splice into every specialist's MEMORY.md.
 *
 * Boots from instrumentation.ts. Skips when there's nothing to do. Tracks
 * a watermark in data/learner-state.json so reruns are cheap (only newly
 * completed tasks since last scan are evaluated). The underlying
 * preference-model.recordLearning is itself idempotent by (agent_id +
 * pattern), so we'd still be safe without the watermark — it just keeps
 * scan cost bounded as the history grows.
 *
 * Kill-switch: LEARNER_SCHEDULER_DISABLED=1
 */
import fs from "fs";
import path from "path";
import { listTasks } from "@/lib/tasks-db";
import { ingestTaskFeedback } from "@/lib/preference-model";

const STATE_PATH = path.join(process.cwd(), "data", "learner-state.json");

interface LearnerState {
  last_run_at: string;
  last_ingested_completed_at: string; // ISO; only tasks completed after this are considered
  total_ingested: number;
}

const DEFAULT_STATE: LearnerState = {
  last_run_at: new Date(0).toISOString(),
  last_ingested_completed_at: new Date(0).toISOString(),
  total_ingested: 0,
};

function readState(): LearnerState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(next: LearnerState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf-8");
}

export interface LearnerRunResult {
  scanned: number;
  ingested: number;
  learnings_written: number;
  state: LearnerState;
}

/**
 * Single learner pass. Pulls every done/cancelled task with a user verdict
 * since the watermark, ingests each, and bumps the watermark on success.
 * Idempotent — safe to call from cron or via the /api/learner/run endpoint.
 */
export function runLearnerOnce(): LearnerRunResult {
  const state = readState();
  // Pull up to 500 most-recent done tasks; filter by completed_at >
  // watermark and user_approved !== null (we need a verdict to learn from).
  const recent = listTasks({ status: "done", limit: 500, sort: "newest" });
  const cutoff = state.last_ingested_completed_at;
  const candidates = recent.filter(
    (t) =>
      t.user_approved !== null &&
      t.completed_at !== null &&
      t.completed_at > cutoff,
  );

  let ingested = 0;
  let learnings_written = 0;
  let maxCompletedAt = cutoff;
  for (const task of candidates) {
    try {
      const result = ingestTaskFeedback(task);
      ingested++;
      learnings_written += result.learnings_written;
      if (task.completed_at && task.completed_at > maxCompletedAt) {
        maxCompletedAt = task.completed_at;
      }
    } catch (err) {
      if (process.env.LEARNER_DEBUG === "1") {
        console.warn("[learner] ingest failed for", task.id, err);
      }
    }
  }

  const next: LearnerState = {
    last_run_at: new Date().toISOString(),
    last_ingested_completed_at: maxCompletedAt,
    total_ingested: state.total_ingested + ingested,
  };
  writeState(next);

  if (process.env.LEARNER_DEBUG === "1") {
    console.log(
      `[learner] scanned=${candidates.length} ingested=${ingested} learnings=${learnings_written} watermark=${maxCompletedAt}`,
    );
  }
  return { scanned: candidates.length, ingested, learnings_written, state: next };
}

/* -------------------- Scheduler glue -------------------- */

const INTERVAL_MS = Number.parseInt(
  process.env.LEARNER_INTERVAL_MS || `${60 * 60 * 1000}`, // hourly by default
  10,
);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    runLearnerOnce();
  } catch (err) {
    console.warn("[learner-scheduler] tick failed:", err);
  } finally {
    running = false;
  }
}

export function startLearnerScheduler(): void {
  if (process.env.LEARNER_SCHEDULER_DISABLED === "1") {
    console.log("[learner-scheduler] disabled via env");
    return;
  }
  if (timer) return; // already started
  // First run after 60s so we don't fight other boot work; then on cadence.
  setTimeout(() => {
    void tick();
  }, 60_000);
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  console.log(`[learner-scheduler] started (interval=${INTERVAL_MS}ms)`);
}

export function stopLearnerScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getLearnerState(): LearnerState {
  return readState();
}
