/**
 * Shared types for the Live Mission dashboard. Mirrors what /api/tasks
 * returns; keeping them in one place avoids the parent + each child
 * declaring slightly-different versions of the same shape.
 */
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

export interface Task {
  id: string;
  parent_task_id: string | null;
  delegated_by: string | null;
  assigned_to: string | null;
  status: TaskStatus;
  title: string;
  prompt: string;
  result: string | null;
  review_verdict: "approved" | "rejected" | "needs_revision" | null;
  review_notes: string | null;
  user_approved: boolean | null;
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

export interface MailMessage {
  id: string;
  task_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string;
  subject: string | null;
  body: string;
  message_type: "queued_note" | "direct_message" | "inter_agent" | "review_feedback";
  created_at: string;
  read_at: string | null;
}

export interface Checkpoint {
  id: string;
  task_id: string;
  agent_id: string;
  checkpoint_data: Record<string, unknown>;
  created_at: string;
}

export interface LiveEvent {
  id: string;
  event_type: string;
  task_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
}

export const STATUS_COLUMNS: TaskStatus[] = [
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "done",
];

/** Statuses that count as "in flight" — a task being orchestrated right now. */
export const ACTIVE_STATUSES: TaskStatus[] = [
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planning: "Planejamento",
  inbox: "Caixa de entrada",
  assigned: "Atribuído",
  in_progress: "Em andamento",
  testing: "Testes",
  review: "Revisão",
  done: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  planning: "#a78bfa",
  inbox: "#94a3b8",
  assigned: "#3b82f6",
  in_progress: "#0ea5e9",
  testing: "#eab308",
  review: "#f97316",
  done: "#22c55e",
  failed: "#ef4444",
  cancelled: "#71717a",
};

export function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Coarse buckets used by the activity feed filter chips. */
export type EventCategory = "missao" | "agente" | "chat" | "sistema";

export function categorizeEvent(type: string): EventCategory {
  if (type.startsWith("task.")) return "missao";
  if (type.startsWith("agent.")) return "agente";
  if (type.startsWith("chat.") || type.startsWith("mailbox.")) return "chat";
  return "sistema";
}

export function eventColor(type: string): string {
  if (type === "task.delegated") return "#a855f7";
  if (type === "task.approved") return "#22c55e";
  if (type === "task.completed") return "#22c55e";
  if (type === "task.reviewed") return "#f97316";
  if (type.startsWith("task.")) return "#3b82f6";
  if (type.startsWith("mailbox.")) return "#a855f7";
  if (type.startsWith("agent.")) return "#10b981";
  if (type.startsWith("dispatcher.")) return "#f59e0b";
  if (type.startsWith("chat.")) return "#ec4899";
  return "#71717a";
}

const statusLabel = (v: unknown) =>
  STATUS_LABELS[v as TaskStatus] ?? String(v ?? "—");

/**
 * Single source of truth for turning a raw live event into a PT-BR
 * sentence a human can scan. Used by both the activity feed and the
 * per-task timeline so the two never drift apart.
 */
export function describeEvent(
  e: LiveEvent,
  agentName: (id: string | null | undefined) => string,
): { icon: string; text: string } {
  switch (e.event_type) {
    case "task.created":
      return { icon: "📥", text: `Nova missão criada: ${String(e.payload.title ?? "").slice(0, 70) || "sem título"}` };
    case "task.delegated":
      return {
        icon: "🔀",
        text: `${agentName(e.payload.delegated_by as string)} delegou para ${agentName(e.payload.assigned_to as string)}: ${String(e.payload.title ?? "").slice(0, 60)}`,
      };
    case "task.status_changed":
      return {
        icon: "🔄",
        text: `${statusLabel(e.payload.from)} → ${statusLabel(e.payload.to)}${e.payload.title ? ` · ${String(e.payload.title).slice(0, 50)}` : ""}`,
      };
    case "task.checkpoint":
      return { icon: "📍", text: `${agentName(e.agent_id)} publicou um checkpoint de progresso` };
    case "task.completed":
      return { icon: "✅", text: `${agentName(e.agent_id) || "Agente"} entregou a missão` };
    case "task.reviewed": {
      const v = e.payload.verdict;
      const label = v === "approved" ? "aprovou" : v === "rejected" ? "rejeitou" : "pediu revisão";
      return { icon: "🛡️", text: `Revisor ${label}${e.payload.notes ? `: ${String(e.payload.notes).slice(0, 60)}` : ""}` };
    }
    case "task.approved":
      return e.payload.approved
        ? { icon: "👍", text: "Você aprovou a entrega" }
        : { icon: "👎", text: `Você rejeitou${e.payload.feedback ? `: ${String(e.payload.feedback).slice(0, 60)}` : ""}` };
    case "mailbox.message": {
      const t = e.payload.message_type;
      const icon = t === "direct_message" ? "🔴" : t === "queued_note" ? "🟡" : t === "review_feedback" ? "🛡️" : "💬";
      return {
        icon,
        text: `${agentName(e.payload.from as string) || "Você"} → ${agentName(e.payload.to as string)}: ${String(e.payload.preview ?? "").slice(0, 70)}`,
      };
    }
    case "agent.heartbeat":
      return { icon: "💓", text: `${agentName(e.agent_id)} está ${stateLabel(e.payload.state)}` };
    case "agent.state_changed":
      return { icon: "🎭", text: `${agentName(e.agent_id)}: ${stateLabel(e.payload.from)} → ${stateLabel(e.payload.to)}` };
    case "dispatcher.run":
      return { icon: "⚙️", text: `Dispatcher: ${e.payload.dispatched ?? 0} despachada(s), ${e.payload.paused ?? 0} pausada(s)` };
    case "chat.turn_started":
      return { icon: "💬", text: `${agentName(e.agent_id)} começou a responder: ${String(e.payload.preview ?? "").slice(0, 60)}` };
    case "chat.tool_use":
      return {
        icon: "🔧",
        text: `${agentName(e.agent_id)} usou ${e.payload.tool}${e.payload.input_preview ? ` (${String(e.payload.input_preview).slice(0, 40)})` : ""}`,
      };
    case "chat.turn_completed": {
      const ok = e.payload.ok;
      const dur = typeof e.payload.duration_ms === "number" ? ` em ${(e.payload.duration_ms / 1000).toFixed(1)}s` : "";
      const tokens = ((e.payload.tokensIn as number) ?? 0) + ((e.payload.tokensOut as number) ?? 0);
      return {
        icon: ok ? "✅" : "⚠️",
        text: `${agentName(e.agent_id)} ${ok ? "concluiu o turno" : "terminou com resposta vazia"}${dur}${tokens ? ` · ${tokens} tokens` : ""}`,
      };
    }
    default:
      return { icon: "•", text: e.event_type };
  }
}

export function stateLabel(v: unknown): string {
  switch (String(v ?? "")) {
    case "working":
      return "trabalhando";
    case "thinking":
      return "pensando";
    case "idle":
      return "ocioso";
    case "offline":
      return "offline";
    case "":
      return "—";
    default:
      return String(v);
  }
}
