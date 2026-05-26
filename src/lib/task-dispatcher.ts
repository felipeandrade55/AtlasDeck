/**
 * Task dispatcher — moves "inbox" tasks to "assigned" once their deps are
 * done and the assignee is under its cost cap. Idempotent and safe to call
 * on a cron or right after a task transitions.
 *
 * Why a separate dispatcher instead of doing this inline at delegation?
 *   - Tasks with `depends_on` only become eligible later when their deps
 *     finish — we need a place to re-check.
 *   - Cost caps must be evaluated against the agent's daily spend so far,
 *     which only the DB knows.
 *   - Keeps delegate endpoint simple (just enqueues; doesn't run).
 *
 * The actual sub-agent invocation (telling OpenClaw to start working on
 * the task) happens out-of-band — for v1 the assignee polls /api/mailbox
 * + /api/tasks at its checkpoint cadence. A future enhancement is to push
 * the assignment via the WS gateway so latency drops.
 */
import { listTasks, updateTask, getAgentCostToday, type Task } from "@/lib/tasks-db";
import { getAgentMeta, type AgentMetaEntry } from "@/lib/agents-meta";
import { getHealth, recordHeartbeat } from "@/lib/agent-health";
import { getOrchestrationSettings, isAutonomousFor } from "@/lib/orchestration-settings";
import { sendMail } from "@/lib/mailbox-db";
import { logActivity } from "@/lib/activities-db";

export type DispatchSkipReason =
  | "deps_pending"
  | "cost_cap_per_task"
  | "cost_cap_per_day"
  | "agent_offline"
  | "no_assignee"
  | "needs_user_approval";

export interface DispatchOutcome {
  task: Task;
  status: "dispatched" | "skipped" | "paused";
  reason?: DispatchSkipReason;
  detail?: string;
}

export interface DispatcherRunResult {
  evaluated: number;
  dispatched: number;
  skipped: number;
  paused: number;
  outcomes: DispatchOutcome[];
}

/**
 * Returns the set of task IDs that are "done" (used to satisfy depends_on).
 * Tasks in `cancelled`/`failed` count as unresolved — they don't unblock
 * downstream work. Failures should be retried (re-delegate) or explicitly
 * resolved by the user before dependents can run.
 */
function buildDoneSet(): Set<string> {
  const done = listTasks({ status: "done", limit: 5000, sort: "newest" });
  return new Set(done.map((t) => t.id));
}

function depsSatisfied(task: Task, doneSet: Set<string>): boolean {
  if (!task.depends_on || task.depends_on.length === 0) return true;
  return task.depends_on.every((id) => doneSet.has(id));
}

interface CapCheck { ok: boolean; reason?: DispatchSkipReason; detail?: string }

function checkCostCaps(task: Task, meta: AgentMetaEntry): CapCheck {
  const settings = getOrchestrationSettings();
  if (!settings.cost_caps_enforce) return { ok: true };

  const caps = meta.cost_caps ?? {};
  const perTask = caps.per_task_cents ?? null;
  const perDay = caps.per_day_cents ?? null;

  // task.cost_cents is the accumulated cost SO FAR. A fresh task has 0 so
  // per_task cap only bites on resumed/retried tasks.
  if (perTask !== null && task.cost_cents > perTask) {
    return {
      ok: false,
      reason: "cost_cap_per_task",
      detail: `task gastou ${task.cost_cents}¢ > cap ${perTask}¢`,
    };
  }
  if (perDay !== null && task.assigned_to) {
    const todaySpend = getAgentCostToday(task.assigned_to);
    if (todaySpend >= perDay) {
      return {
        ok: false,
        reason: "cost_cap_per_day",
        detail: `agente já gastou ${todaySpend}¢ hoje (cap ${perDay}¢)`,
      };
    }
  }
  return { ok: true };
}

/**
 * Evaluate a single task. Caller is expected to have already filtered to
 * status `inbox`. Mutates the task in DB on success (status → assigned).
 */
export function dispatchOne(task: Task, doneSet: Set<string>): DispatchOutcome {
  if (!task.assigned_to) {
    return { task, status: "skipped", reason: "no_assignee" };
  }
  if (!depsSatisfied(task, doneSet)) {
    return { task, status: "skipped", reason: "deps_pending" };
  }

  const meta = getAgentMeta(task.assigned_to);
  const cap = checkCostCaps(task, meta);
  if (!cap.ok) {
    // Cost cap exceeded: log + notify the orchestrator (if any) but DON'T
    // re-queue silently. The user/orchestrator decides whether to lift the
    // cap or pause the agent.
    if (task.delegated_by) {
      sendMail({
        task_id: task.id,
        from_agent_id: null,
        to_agent_id: task.delegated_by,
        subject: "Cost cap atingido",
        body: `Não dispatchou ${task.id}: ${cap.detail}. Ajuste o cap ou cancele.`,
        message_type: "inter_agent",
      });
    }
    logActivity("task", `Cost cap bloqueou dispatch: ${task.title || task.id}`, "pending", {
      agent: task.assigned_to ?? undefined,
      metadata: { task_id: task.id, reason: cap.reason, detail: cap.detail },
    });
    return { task, status: "paused", reason: cap.reason, detail: cap.detail };
  }

  // Move to assigned + bump heartbeat so dashboards reflect it immediately.
  const updated = updateTask(task.id, { status: "assigned" });
  // recordHeartbeat preserves existing state_changed_at when state is unchanged.
  recordHeartbeat({
    agent_id: task.assigned_to,
    state: "thinking",
    current_task_id: task.id,
  });

  logActivity("task", `Dispatch: ${task.assigned_to} ← ${task.title || task.id}`, "success", {
    agent: task.assigned_to ?? undefined,
    metadata: { task_id: task.id, autonomous: isAutonomousFor(meta.override_autonomous) },
  });

  return { task: updated ?? task, status: "dispatched" };
}

/**
 * Single pass over every `inbox` task. Returns a summary the caller can
 * surface in the UI (kanban → green flash for newly-dispatched cards,
 * red badge for paused).
 */
export function runDispatcher(): DispatcherRunResult {
  const inbox = listTasks({ status: "inbox", limit: 500, sort: "oldest" });
  const doneSet = buildDoneSet();

  const outcomes: DispatchOutcome[] = [];
  let dispatched = 0;
  let skipped = 0;
  let paused = 0;
  for (const t of inbox) {
    const outcome = dispatchOne(t, doneSet);
    outcomes.push(outcome);
    if (outcome.status === "dispatched") dispatched++;
    else if (outcome.status === "paused") paused++;
    else skipped++;
  }

  return {
    evaluated: inbox.length,
    dispatched,
    skipped,
    paused,
    outcomes,
  };
}

/**
 * Helper for the orchestrator-tools `check_progress` handler — picks
 * useful state about an agent without exposing the raw DB shape.
 */
export function snapshotAgent(agentId: string) {
  const meta = getAgentMeta(agentId);
  const health = getHealth(agentId);
  const inbox = listTasks({ status: "inbox", assigned_to: agentId, limit: 50 });
  const active = listTasks({
    status: ["assigned", "in_progress", "testing", "review"],
    assigned_to: agentId,
    limit: 50,
  });
  const today = listTasks({ assigned_to: agentId, limit: 200 }).filter(
    (t) => new Date(t.created_at).toDateString() === new Date().toDateString(),
  );
  const spendToday = today.reduce((a, t) => a + t.cost_cents, 0);
  return {
    agent_id: agentId,
    role: meta.role,
    specialty: meta.specialty,
    autonomous: isAutonomousFor(meta.override_autonomous),
    health,
    in_flight: active.length,
    inbox: inbox.length,
    spend_today_cents: spendToday,
    cost_caps: meta.cost_caps ?? {},
  };
}
