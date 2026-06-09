/**
 * Subagent execution worker — the missing piece that makes delegated tasks
 * ACTUALLY run.
 *
 * Until now, delegating a task (via delegate_to / the UI) only created a row
 * in the tasks DB and moved it inbox → assigned via the dispatcher. Nothing
 * ever told the specialist sub-agent to start working, so the card sat in
 * "assigned" forever (task-dispatcher.ts documents this: "the actual
 * sub-agent invocation happens out-of-band").
 *
 * This worker closes that loop. On a short interval it:
 *   1. Runs the dispatcher (inbox → assigned, respecting deps + cost caps).
 *   2. Picks up `assigned` tasks (concurrency-capped, one per agent) and
 *      actually RUNS the specialist sub-agent via the OpenClaw runner —
 *      the same path the chat uses, but driven by the task prompt.
 *   3. Streams the sub-agent's work, moving the card assigned → in_progress
 *      → review (or done when autonomous) and publishing live events the
 *      Live Mission board renders in real time.
 *
 * Safety: capped concurrency, one in-flight task per agent, a hard per-task
 * timeout, and an env kill-switch (ATLAS_SUBAGENT_WORKER=off). Cost caps are
 * already enforced upstream by the dispatcher before a task becomes
 * `assigned`, so the worker only ever runs work that's been cleared to run.
 */
import { listTasks, updateTask, getTaskById, type Task } from "@/lib/tasks-db";
import { runDispatcher } from "@/lib/task-dispatcher";
import { runOpenClawChat } from "@/lib/openclaw-runner";
import { publishEvent } from "@/lib/live-events";
import { recordHeartbeat } from "@/lib/agent-health";
import { createThread, appendMessage } from "@/lib/chat-db";
import { getOrchestrationSettings, isAutonomousFor } from "@/lib/orchestration-settings";
import { getAgentMeta } from "@/lib/agents-meta";
import { logActivity } from "@/lib/activities-db";

// How many sub-agent runs may execute at once across the whole swarm. Kept
// low so the worker never floods the single OpenClaw gateway (the same one
// that serves Telegram/web) — that's what caused the agent overflow.
const MAX_CONCURRENT = 2;
// Hard ceiling per task so a stuck sub-agent can't pin a worker slot forever.
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
// Don't auto-run tasks that have been sitting `assigned` for longer than this.
// Protects against a first-boot stampede on stale/test tasks left in the DB —
// a freshly delegated task gets picked up within one tick, so anything this
// old was never going to run and shouldn't suddenly fire (and cost tokens).
const STALE_ASSIGNED_MS = 24 * 60 * 60 * 1000;

const inFlight = new Set<string>();
let started = false;

function workerEnabled(): boolean {
  return (process.env.ATLAS_SUBAGENT_WORKER || "on").toLowerCase() !== "off";
}

/**
 * Run a single assigned task through its specialist sub-agent. Moves the
 * card through the columns and publishes the events the board listens for.
 * Never throws — failures land the card in `failed` with the error text.
 */
async function executeTask(task: Task): Promise<void> {
  if (!task.assigned_to) return;
  inFlight.add(task.id);
  const agentId = task.assigned_to;

  try {
    updateTask(task.id, { status: "in_progress" });
    publishEvent({
      event_type: "task.status_changed",
      task_id: task.id,
      agent_id: agentId,
      payload: { from: "assigned", to: "in_progress", by: "worker" },
    });
    recordHeartbeat({ agent_id: agentId, state: "working", current_task_id: task.id });

    // A dedicated thread so the sub-agent run shows up in the chat history
    // and the runner has somewhere to attach its session id.
    const thread = createThread({
      agent_id: agentId,
      workspace: task.workspace_path ?? null,
      source: "worker",
      title: task.title || task.prompt.slice(0, 80),
    });
    appendMessage({
      thread_id: thread.id,
      role: "user",
      content: task.prompt,
      status: "complete",
    });

    // Anti-cascade: a specialist run by the worker must DO the work itself,
    // never re-delegate. The sub-agent has the same delegate_to/decompose MCP
    // tools as the orchestrator, so without this it can spawn a second task
    // (the confusing "two cards at once") and, worse, an unbounded chain.
    const workerPrompt =
      `${task.prompt}\n\n[atlas:worker] Você é um sub-agente especialista executando uma ` +
      `tarefa que JÁ foi delegada a você. FAÇA o trabalho você mesmo e entregue o resultado ` +
      `aqui. NÃO chame delegate_to, decompose nem nenhuma ferramenta de delegação — você é o ` +
      `executor final, não o orquestrador.`;

    let output = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), TASK_TIMEOUT_MS);
    try {
      for await (const evt of runOpenClawChat({
        agentId,
        prompt: workerPrompt,
        threadId: thread.id,
        workspace: task.workspace_path ?? null,
        signal: ac.signal,
        mode: "openclaw",
      })) {
        if (evt.type === "token") {
          output += evt.delta;
        } else if (evt.type === "usage") {
          tokensIn = evt.tokensIn;
          tokensOut = evt.tokensOut;
          cost = evt.cost ?? cost;
        } else if (evt.type === "tool_use") {
          // Surface each tool the sub-agent uses as a checkpoint so the
          // board shows live motion while the specialist works.
          publishEvent({
            event_type: "task.checkpoint",
            task_id: task.id,
            agent_id: agentId,
            payload: { tool: evt.name },
          });
        } else if (evt.type === "done" || evt.type === "error") {
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    appendMessage({
      thread_id: thread.id,
      role: "assistant",
      content: output,
      status: output.trim() ? "complete" : "error",
    });

    const settings = getOrchestrationSettings();
    const meta = getAgentMeta(agentId);
    const autonomous = isAutonomousFor(meta.override_autonomous);
    const ok = Boolean(output.trim());

    // Autonomous + no mandatory approval → straight to done. Otherwise the
    // card lands in `review` for the user/orchestrator to sign off.
    const nextStatus: Task["status"] = !ok
      ? "failed"
      : autonomous && !settings.require_user_approval
        ? "done"
        : "review";

    updateTask(task.id, {
      status: nextStatus,
      result: output.slice(0, 4000),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_cents: Math.round((cost ?? 0) * 100),
    });
    publishEvent({
      event_type: ok ? "task.completed" : "task.status_changed",
      task_id: task.id,
      agent_id: agentId,
      payload: { status: nextStatus, tokensIn, tokensOut },
    });
    recordHeartbeat({ agent_id: agentId, state: "idle", current_task_id: null });
    logActivity(
      "task",
      `Subagente ${agentId} executou: ${task.title || task.id}`,
      ok ? "success" : "error",
      { agent: agentId, metadata: { task_id: task.id, status: nextStatus, tokensIn, tokensOut } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateTask(task.id, { status: "failed", result: `Worker error: ${message}` });
    publishEvent({
      event_type: "task.status_changed",
      task_id: task.id,
      agent_id: agentId,
      payload: { status: "failed", error: message },
    });
    recordHeartbeat({ agent_id: agentId, state: "idle", current_task_id: null });
    console.warn(`[task-worker] task ${task.id} failed:`, message);
  } finally {
    inFlight.delete(task.id);
  }
}

/**
 * One scheduling pass: dispatch the inbox, then start as many eligible
 * `assigned` tasks as the concurrency budget allows (one per agent).
 */
async function tick(): Promise<void> {
  if (!workerEnabled()) return;
  try {
    runDispatcher();

    if (inFlight.size >= MAX_CONCURRENT) return;

    // Which agents are already busy (so we serialize per agent).
    const busyAgents = new Set<string>();
    for (const id of inFlight) {
      const t = getTaskById(id);
      if (t?.assigned_to) busyAgents.add(t.assigned_to);
    }

    const assigned = listTasks({ status: "assigned", limit: 50, sort: "oldest" });
    const now = Date.now();
    for (const task of assigned) {
      if (inFlight.size >= MAX_CONCURRENT) break;
      if (!task.assigned_to) continue;
      if (inFlight.has(task.id)) continue;
      if (busyAgents.has(task.assigned_to)) continue;
      // Skip stale leftovers so we don't auto-run weeks-old test tasks.
      if (now - new Date(task.created_at).getTime() > STALE_ASSIGNED_MS) continue;
      busyAgents.add(task.assigned_to);
      // Fire without awaiting so multiple specialists run concurrently.
      // executeTask adds to `inFlight` synchronously before its first await,
      // so the next tick won't double-pick it.
      void executeTask(task);
    }
  } catch (err) {
    console.warn("[task-worker] tick failed:", err);
  }
}

/**
 * Boot the worker loop. Idempotent (guards against Next's dual-runtime
 * instrumentation double-call). Off entirely when ATLAS_SUBAGENT_WORKER=off.
 */
export function startTaskWorker(intervalMs = 12_000): void {
  if (started) return;
  started = true;
  if (!workerEnabled()) {
    console.log("[task-worker] disabled via ATLAS_SUBAGENT_WORKER=off");
    return;
  }
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[task-worker] started (subagent execution loop)");
}
