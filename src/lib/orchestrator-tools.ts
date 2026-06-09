/**
 * Orchestrator tool contract — the language the orchestrator (Jarvis)
 * speaks back to AtlasDeck. There are two paths a tool call can travel:
 *
 *   1. Native OpenClaw tool/function calling, if the gateway exposes it
 *      (preferred — keeps the LLM in flow).
 *   2. Text-protocol fallback: the LLM emits a fenced block like
 *        ```atlas-tool delegate_to
 *        { "agent_id": "dev", "task": "..." }
 *        ```
 *      and the chat-stream route detects + invokes /api/orchestrator/tool-call.
 *
 * Both paths land here. We expose:
 *   - TOOL_DEFINITIONS: schema for the prompt injection
 *   - executeTool(): server-side handler that runs the tool against our DB
 *
 * Returning a structured result lets us round-trip status back into the
 * orchestrator's context on the next turn ("delegate_to → task_id=...").
 */
import {
  createTask,
  updateTask,
  getTaskById,
  listChildren,
  listTasks,
  type Task,
  type ReviewVerdict,
} from "@/lib/tasks-db";
import { ensureTaskWorkspace } from "@/lib/task-workspace";
import { sendMail, type MailMessageType } from "@/lib/mailbox-db";
import { recordHeartbeat } from "@/lib/agent-health";
import { snapshotAgent } from "@/lib/task-dispatcher";
import { logActivity } from "@/lib/activities-db";
import { publishEvent } from "@/lib/live-events";

export type OrchestratorToolName =
  | "delegate_to"
  | "decompose"
  | "check_progress"
  | "send_note"
  | "review"
  | "notify_user"
  | "approve_task"
  | "reject_task";

export interface ToolDefinition {
  name: OrchestratorToolName;
  description: string;
  parameters_schema: Record<string, unknown>; // JSON Schema (for OpenAI-style tool calling)
  example: string;
}

/**
 * Public schema list, formatted ready to inject into a system prompt.
 * Keep `description` user-facing — the LLM reads it verbatim.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "delegate_to",
    description:
      "Delegate a single task to a specialist sub-agent. Use this when the request maps cleanly to one specialist (e.g. a coding task → dev).",
    parameters_schema: {
      type: "object",
      required: ["agent_id", "task"],
      properties: {
        agent_id: { type: "string", description: "The sub-agent's id (e.g. \"dev\")." },
        task: { type: "string", description: "Plain-language description of what to do." },
        title: { type: "string", description: "Short label for kanban (optional)." },
        context: { type: "string", description: "Extra context the specialist will need." },
      },
    },
    example: `delegate_to({ "agent_id": "dev", "task": "implementar paginação no /list" })`,
  },
  {
    name: "decompose",
    description:
      "Break a complex request into a DAG of subtasks with dependencies. Use when one specialist isn't enough — e.g. \"implementa feature X\" → [design, backend, frontend, tests].",
    parameters_schema: {
      type: "object",
      required: ["parent_prompt", "subtasks"],
      properties: {
        parent_prompt: { type: "string", description: "The original user request." },
        subtasks: {
          type: "array",
          items: {
            type: "object",
            required: ["agent_id", "task"],
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
              title: { type: "string" },
              depends_on: {
                type: "array",
                items: { type: "string" },
                description: "Indexes (\"0\",\"1\",…) referring to earlier subtasks in this same call.",
              },
            },
          },
        },
      },
    },
    example: `decompose({ "parent_prompt": "implementar comments", "subtasks": [{"agent_id":"designer","task":"mockup UI"},{"agent_id":"dev","task":"backend + frontend","depends_on":["0"]}] })`,
  },
  {
    name: "check_progress",
    description: "Get live state of one or more tasks in flight, or all agents.",
    parameters_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        agent_id: { type: "string" },
      },
    },
    example: `check_progress({ "agent_id": "dev" })`,
  },
  {
    name: "send_note",
    description:
      "Send a note to a sub-agent mid-task. Use urgent=true to broadcast a direct_message (interrupts the agent's loop); otherwise it's queued for the next checkpoint.",
    parameters_schema: {
      type: "object",
      required: ["agent_id", "body"],
      properties: {
        agent_id: { type: "string" },
        body: { type: "string" },
        subject: { type: "string" },
        urgent: { type: "boolean" },
        task_id: { type: "string" },
      },
    },
    example: `send_note({ "agent_id": "dev", "body": "incluir testes de borda", "urgent": false })`,
  },
  {
    name: "review",
    description:
      "Post a review verdict on a sub-agent's completed task. approved keeps the task in `review` waiting for user thumbs-up (or auto-advances if autonomous_mode is on). rejected bounces it back to assigned with feedback.",
    parameters_schema: {
      type: "object",
      required: ["task_id", "verdict"],
      properties: {
        task_id: { type: "string" },
        verdict: { type: "string", enum: ["approved", "rejected", "needs_revision"] },
        notes: { type: "string" },
      },
    },
    example: `review({ "task_id": "abc-123", "verdict": "approved", "notes": "ok" })`,
  },
  {
    name: "notify_user",
    description:
      "Send a status update to the human user. Use this when a task completes or when a long-running plan needs human attention.",
    parameters_schema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        task_id: { type: "string" },
        channels: {
          type: "array",
          items: { type: "string", enum: ["chat", "telegram"] },
          description: "Default: the channel the original request came from.",
        },
      },
    },
    example: `notify_user({ "message": "Task X concluída, aguardando 👍/👎.", "task_id": "abc-123" })`,
  },
  {
    name: "approve_task",
    description:
      "Aprovar uma task que está em `review` — move para `done`. Use quando o usuário aprovar a entrega (ex: responde 'aprovar', 'pode publicar', 'tá bom' no Telegram/chat referindo-se a uma task em revisão).",
    parameters_schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Id (ou prefixo de 8 chars) da task em review." },
      },
    },
    example: `approve_task({ "task_id": "ce6aa1c3" })`,
  },
  {
    name: "reject_task",
    description:
      "Rejeitar uma task em `review` — volta para `assigned` e o especialista refaz com o feedback. Use quando o usuário pedir ajustes ('refaz', 'não gostei', 'muda X').",
    parameters_schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Id (ou prefixo de 8 chars) da task." },
        reason: { type: "string", description: "O que o usuário quer ajustado (vai pro especialista)." },
      },
    },
    example: `reject_task({ "task_id": "ce6aa1c3", "reason": "incluir fontes oficiais" })`,
  },
];

/* -------------------- Input validation (hand-rolled to keep zero deps) -------------------- */

class ValidationError extends Error {}

function asObj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new ValidationError("argumentos devem ser um objeto");
  return raw as Record<string, unknown>;
}
function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ValidationError(`campo "${key}" obrigatório (string não-vazia)`);
  }
  return v;
}
function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`campo "${key}" deve ser string`);
  return v;
}
function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`campo "${key}" deve ser boolean`);
  return v;
}
function optStringArray(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError(`campo "${key}" deve ser array de strings`);
  return v.map((x) => {
    if (typeof x !== "string") throw new ValidationError(`campo "${key}[]" deve conter strings`);
    return x;
  });
}
function inEnum<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`campo "${key}" deve ser um de: ${allowed.join(", ")}`);
  }
  return value as T;
}

interface DelegateArgs {
  agent_id: string; task: string; title?: string; context?: string;
  parent_task_id?: string; depends_on?: string[]; parent_agent_id?: string;
}
function parseDelegate(raw: unknown): DelegateArgs {
  const o = asObj(raw);
  return {
    agent_id: requireString(o, "agent_id"),
    task: requireString(o, "task"),
    title: optString(o, "title"),
    context: optString(o, "context"),
    parent_task_id: optString(o, "parent_task_id"),
    depends_on: optStringArray(o, "depends_on"),
    parent_agent_id: optString(o, "parent_agent_id"),
  };
}

interface SubtaskArgs { agent_id: string; task: string; title?: string; depends_on?: string[] }
interface DecomposeArgs { parent_prompt: string; parent_agent_id?: string; subtasks: SubtaskArgs[] }
function parseDecompose(raw: unknown): DecomposeArgs {
  const o = asObj(raw);
  const subs = o.subtasks;
  if (!Array.isArray(subs) || subs.length === 0) {
    throw new ValidationError(`campo "subtasks" obrigatório (array não-vazio)`);
  }
  return {
    parent_prompt: requireString(o, "parent_prompt"),
    parent_agent_id: optString(o, "parent_agent_id"),
    subtasks: subs.map((s, i) => {
      const so = asObj(s);
      try {
        return {
          agent_id: requireString(so, "agent_id"),
          task: requireString(so, "task"),
          title: optString(so, "title"),
          depends_on: optStringArray(so, "depends_on"),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ValidationError(`subtask[${i}]: ${msg}`);
      }
    }),
  };
}

interface CheckProgressArgs { task_id?: string; agent_id?: string }
function parseCheckProgress(raw: unknown): CheckProgressArgs {
  const o = asObj(raw);
  return { task_id: optString(o, "task_id"), agent_id: optString(o, "agent_id") };
}

interface SendNoteArgs {
  agent_id: string; body: string; subject?: string; urgent?: boolean;
  task_id?: string; from_agent_id?: string;
}
function parseSendNote(raw: unknown): SendNoteArgs {
  const o = asObj(raw);
  return {
    agent_id: requireString(o, "agent_id"),
    body: requireString(o, "body"),
    subject: optString(o, "subject"),
    urgent: optBool(o, "urgent"),
    task_id: optString(o, "task_id"),
    from_agent_id: optString(o, "from_agent_id"),
  };
}

interface ReviewArgs {
  task_id: string; verdict: ReviewVerdict; notes?: string; reviewer_id?: string;
}
function parseReview(raw: unknown): ReviewArgs {
  const o = asObj(raw);
  const verdictRaw = requireString(o, "verdict");
  const verdict = inEnum(verdictRaw, ["approved", "rejected", "needs_revision"] as const, "verdict");
  return {
    task_id: requireString(o, "task_id"),
    verdict,
    notes: optString(o, "notes"),
    reviewer_id: optString(o, "reviewer_id"),
  };
}

type NotifyChannel = "chat" | "telegram";
interface NotifyUserArgs {
  message: string; task_id?: string; channels?: NotifyChannel[]; from_agent_id?: string;
}
function parseNotifyUser(raw: unknown): NotifyUserArgs {
  const o = asObj(raw);
  const channelsRaw = optStringArray(o, "channels");
  const channels = channelsRaw?.map((c) => inEnum(c, ["chat", "telegram"] as const, "channels[]"));
  return {
    message: requireString(o, "message"),
    task_id: optString(o, "task_id"),
    channels,
    from_agent_id: optString(o, "from_agent_id"),
  };
}

/* -------------------- Handlers -------------------- */

/**
 * Resolve a task reference that may be a full UUID or just the 8-char prefix
 * the agent surfaces to the user ("Task ID: ce6aa1c3"). Prefers an exact id;
 * falls back to a unique prefix match among recent tasks.
 */
function resolveTaskRef(ref: string): Task | null {
  const exact = getTaskById(ref);
  if (exact) return exact;
  const needle = ref.trim().toLowerCase();
  if (needle.length < 4) return null;
  const matches = listTasks({ limit: 500, sort: "newest" }).filter((t) =>
    t.id.toLowerCase().startsWith(needle),
  );
  return matches.length === 1 ? matches[0] : null;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  tool: OrchestratorToolName;
  result?: T;
  error?: string;
}

export async function executeTool(
  name: OrchestratorToolName,
  rawArgs: unknown,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "delegate_to": {
        const args = parseDelegate(rawArgs);
        // Who is delegating. The orchestrator is the entry point (Jarvis =
        // "main") unless the caller explicitly names a different parent.
        const delegatedBy = args.parent_agent_id ?? "main";
        const task = createTask({
          parent_task_id: args.parent_task_id ?? null,
          delegated_by: delegatedBy,
          assigned_to: args.agent_id,
          status: "inbox",
          title: args.title || args.task.slice(0, 80),
          prompt: args.context ? `${args.task}\n\nContext:\n${args.context}` : args.task,
          depends_on: args.depends_on ?? [],
        });
        const ws = ensureTaskWorkspace(task.id);
        const updated = updateTask(task.id, { workspace_path: ws.relativePath });
        sendMail({
          task_id: task.id,
          from_agent_id: delegatedBy,
          to_agent_id: args.agent_id,
          subject: "Nova tarefa delegada",
          body: args.task.slice(0, 400),
          message_type: "inter_agent",
        });
        // Dedicated delegation event so the dashboard can show the
        // orchestration ("main → dev") distinctly from a plain chat task.
        publishEvent({
          event_type: "task.delegated",
          task_id: task.id,
          agent_id: delegatedBy,
          payload: {
            delegated_by: delegatedBy,
            assigned_to: args.agent_id,
            title: task.title,
          },
        });
        logActivity("task", `Tool delegate_to: ${args.agent_id}`, "success", {
          agent: args.agent_id,
          metadata: { task_id: task.id, delegated_by: delegatedBy },
        });
        return { ok: true, tool: name, result: { task: updated ?? task } };
      }

      case "decompose": {
        const args = parseDecompose(rawArgs);
        const decomposedBy = args.parent_agent_id ?? "main";
        const parent = createTask({
          delegated_by: decomposedBy,
          assigned_to: null,
          status: "planning",
          title: args.parent_prompt.slice(0, 80),
          prompt: args.parent_prompt,
        });

        // Resolve depends_on indexes to actual ids as we create subtasks
        // in order. We allow either "0","1",… (positional) or already-real
        // task ids (string) — recursive decompositions stay flexible.
        const created: Task[] = [];
        for (let i = 0; i < args.subtasks.length; i++) {
          const sub = args.subtasks[i];
          const resolvedDeps = (sub.depends_on ?? []).map((d) => {
            const idx = Number(d);
            if (Number.isInteger(idx) && idx >= 0 && idx < created.length) {
              return created[idx].id;
            }
            return d;
          });
          const child = createTask({
            parent_task_id: parent.id,
            delegated_by: decomposedBy,
            assigned_to: sub.agent_id,
            status: "inbox",
            title: sub.title || sub.task.slice(0, 80),
            prompt: sub.task,
            depends_on: resolvedDeps,
          });
          const ws = ensureTaskWorkspace(child.id);
          const updatedChild = updateTask(child.id, { workspace_path: ws.relativePath });
          created.push(updatedChild ?? child);
          publishEvent({
            event_type: "task.delegated",
            task_id: child.id,
            agent_id: decomposedBy,
            payload: {
              delegated_by: decomposedBy,
              assigned_to: sub.agent_id,
              title: child.title,
              parent_task_id: parent.id,
            },
          });
        }
        logActivity("task", `Tool decompose: ${args.subtasks.length} subtasks`, "success", {
          metadata: { parent_task_id: parent.id, delegated_by: decomposedBy },
        });
        return { ok: true, tool: name, result: { parent, subtasks: created } };
      }

      case "check_progress": {
        const args = parseCheckProgress(rawArgs);
        if (args.task_id) {
          const task = getTaskById(args.task_id);
          if (!task) return { ok: false, tool: name, error: "Task not found" };
          const children = listChildren(args.task_id);
          return { ok: true, tool: name, result: { task, children } };
        }
        if (args.agent_id) {
          return { ok: true, tool: name, result: { snapshot: snapshotAgent(args.agent_id) } };
        }
        return { ok: false, tool: name, error: "Provide either task_id or agent_id" };
      }

      case "send_note": {
        const args = parseSendNote(rawArgs);
        const message_type: MailMessageType = args.urgent ? "direct_message" : "queued_note";
        const msg = sendMail({
          task_id: args.task_id ?? null,
          from_agent_id: args.from_agent_id ?? null,
          to_agent_id: args.agent_id,
          subject: args.subject,
          body: args.body,
          message_type,
        });
        return { ok: true, tool: name, result: { message: msg } };
      }

      case "review": {
        const args = parseReview(rawArgs);
        const task = getTaskById(args.task_id);
        if (!task) return { ok: false, tool: name, error: "Task not found" };

        const verdict = args.verdict;
        const nextStatus = verdict === "approved" ? "review" : "assigned";
        const updated = updateTask(args.task_id, {
          status: nextStatus,
          review_verdict: verdict,
          review_notes: args.notes ?? null,
        });

        if (verdict !== "approved" && task.assigned_to) {
          sendMail({
            task_id: task.id,
            from_agent_id: args.reviewer_id ?? null,
            to_agent_id: task.assigned_to,
            subject: verdict === "rejected" ? "Review: rejeitado" : "Review: precisa revisão",
            body: args.notes || "Refaça levando em conta as observações do orquestrador.",
            message_type: "review_feedback",
          });
        }
        return { ok: true, tool: name, result: { task: updated ?? task } };
      }

      case "notify_user": {
        const args = parseNotifyUser(rawArgs);
        // Default channel routing: if task has origin_channel in metadata,
        // use that; otherwise honour what the caller asked for or fall
        // back to chat.
        let channels: NotifyChannel[] = args.channels ?? ["chat"];
        if (args.task_id) {
          const task = getTaskById(args.task_id);
          const origin = task?.metadata && typeof task.metadata === "object"
            ? (task.metadata as { origin_channel?: string }).origin_channel
            : undefined;
          if (origin === "telegram") channels = ["telegram"];
          else if (origin === "chat") channels = ["chat"];
        }

        logActivity("message", `Jarvis notifica usuário: ${args.message.slice(0, 80)}`, "success", {
          agent: args.from_agent_id ?? undefined,
          metadata: { task_id: args.task_id, channels },
        });

        // Actual delivery to Telegram is wired later in the integration
        // layer; here we just write to the activity feed + a "user mailbox"
        // entry so the UI can surface it inline.
        sendMail({
          task_id: args.task_id ?? null,
          from_agent_id: args.from_agent_id ?? null,
          to_agent_id: "user",
          subject: "Notificação do Jarvis",
          body: args.message,
          message_type: "direct_message",
        });
        return { ok: true, tool: name, result: { delivered_to: channels } };
      }

      case "approve_task": {
        const args = asObj(rawArgs);
        const taskRef = requireString(args, "task_id");
        const task = resolveTaskRef(taskRef);
        if (!task) return { ok: false, tool: name, error: `Task não encontrada: ${taskRef}` };
        const updated = updateTask(task.id, {
          user_approved: true,
          status: "done",
        });
        logActivity("task", `Usuário 👍 aprovou (via agente): ${task.title || task.id}`, "success", {
          agent: task.assigned_to ?? undefined,
          metadata: { task_id: task.id },
        });
        return { ok: true, tool: name, result: { task: updated ?? task } };
      }

      case "reject_task": {
        const args = asObj(rawArgs);
        const taskRef = requireString(args, "task_id");
        const reason = optString(args, "reason");
        const task = resolveTaskRef(taskRef);
        if (!task) return { ok: false, tool: name, error: `Task não encontrada: ${taskRef}` };
        const updated = updateTask(task.id, {
          user_approved: false,
          user_feedback: reason ?? null,
          status: "assigned", // back to the worker, which re-runs the specialist
        });
        if (task.assigned_to) {
          sendMail({
            task_id: task.id,
            from_agent_id: null,
            to_agent_id: task.assigned_to,
            subject: "Usuário pediu ajustes",
            body: reason || "O usuário rejeitou esta entrega. Refaça levando em conta o histórico.",
            message_type: "review_feedback",
          });
        }
        logActivity("task", `Usuário 👎 rejeitou (via agente): ${task.title || task.id}`, "pending", {
          agent: task.assigned_to ?? undefined,
          metadata: { task_id: task.id, reason },
        });
        return { ok: true, tool: name, result: { task: updated ?? task } };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, tool: name, error: message };
  }
}

/**
 * Pretty-formatted markdown describing each tool — used by
 * orchestrator-injector to seed the orchestrator's MEMORY.md.
 */
export function renderToolDocs(): string {
  return TOOL_DEFINITIONS.map((t) => {
    return [
      `### \`${t.name}\``,
      t.description,
      "",
      "**Exemplo:**",
      `\`\`\`\n${t.example}\n\`\`\``,
    ].join("\n");
  }).join("\n\n");
}
