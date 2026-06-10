"use client";

import { useMemo, useState } from "react";
import {
  STATUS_LABELS,
  describeEvent,
  eventColor,
  formatClock,
  formatElapsed,
  type AgentInfo,
  type Checkpoint,
  type LiveEvent,
  type MailMessage,
  type Task,
  type TaskStatus,
} from "./types";

interface Props {
  task: Task;
  events: LiveEvent[];
  checkpoints: Checkpoint[];
  messages: MailMessage[];
  agents: AgentInfo[];
}

interface Entry {
  id: string;
  at: string; // ISO
  icon: string;
  color: string;
  text: string;
  /** Extra line shown under the main text (e.g. dwell time in a phase). */
  sub?: string;
  /** Expandable raw detail (full message body / checkpoint payload). */
  detail?: string;
  who?: string;
}

/**
 * Chronological merged timeline of everything that happened in one mission:
 * status transitions (with how long each phase took), checkpoints, messages,
 * review verdicts and the user's approval. Events are pruned after 24h
 * server-side, so the skeleton (created/started/completed) is synthesized
 * from the task row itself — old missions still get a meaningful timeline.
 */
export function TaskTimeline({ task, events, checkpoints, messages, agents }: Props) {
  const [detailed, setDetailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a]));
    return (id: string | null | undefined) => {
      if (!id) return "";
      const a = m.get(id);
      return a ? `${a.emoji ?? "🤖"} ${a.name}` : id;
    };
  }, [agents]);

  const entries = useMemo(() => {
    const list: Entry[] = [];

    // 1. Synthesized skeleton from the task row (survives event pruning).
    list.push({
      id: `${task.id}-created`,
      at: task.created_at,
      icon: "🧭",
      color: "#a78bfa",
      text: task.delegated_by
        ? `Missão criada por ${agentName(task.delegated_by)} para ${agentName(task.assigned_to) || "—"}`
        : "Missão criada",
      detail: task.prompt,
      who: task.delegated_by ?? undefined,
    });

    const hasStatusEvents = events.some((e) => e.event_type === "task.status_changed");
    if (!hasStatusEvents && task.started_at) {
      list.push({
        id: `${task.id}-started`,
        at: task.started_at,
        icon: "▶️",
        color: "#0ea5e9",
        text: `${agentName(task.assigned_to) || "Agente"} começou a trabalhar`,
        sub: `ficou ${formatElapsed(new Date(task.started_at).getTime() - new Date(task.created_at).getTime())} na fila`,
      });
    }
    if (!hasStatusEvents && task.completed_at) {
      list.push({
        id: `${task.id}-completed`,
        at: task.completed_at,
        icon: task.status === "failed" ? "❌" : task.status === "cancelled" ? "🚫" : "🏁",
        color: task.status === "failed" ? "#ef4444" : task.status === "cancelled" ? "#71717a" : "#22c55e",
        text:
          task.status === "failed"
            ? "Missão falhou"
            : task.status === "cancelled"
            ? "Missão cancelada"
            : "Missão concluída",
        sub: task.started_at
          ? `tempo de execução: ${formatElapsed(new Date(task.completed_at).getTime() - new Date(task.started_at).getTime())}`
          : undefined,
      });
    }

    // 2. Live events. Skip types whose content comes from durable tables
    //    (checkpoint/mailbox) and the redundant task.created.
    const skip = new Set(["task.created", "task.checkpoint", "mailbox.message"]);
    let lastTransitionAt = task.created_at;
    const sortedEvents = [...events].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (const e of sortedEvents) {
      if (skip.has(e.event_type)) continue;
      const isChatNoise = e.event_type.startsWith("chat.") || e.event_type.startsWith("agent.") || e.event_type.startsWith("dispatcher.");
      if (isChatNoise && !detailed) continue;
      const { icon, text } = describeEvent(e, agentName);
      let sub: string | undefined;
      if (e.event_type === "task.status_changed") {
        const dwell = new Date(e.created_at).getTime() - new Date(lastTransitionAt).getTime();
        const from = STATUS_LABELS[e.payload.from as TaskStatus];
        if (dwell > 1000 && from) sub = `ficou ${formatElapsed(dwell)} em ${from}`;
        lastTransitionAt = e.created_at;
      }
      list.push({
        id: e.id,
        at: e.created_at,
        icon,
        color: eventColor(e.event_type),
        text,
        sub,
        who: e.agent_id ?? undefined,
        detail:
          Object.keys(e.payload).length > 0 && detailed
            ? JSON.stringify(e.payload, null, 2)
            : undefined,
      });
    }

    // 3. Checkpoints (durable progress markers from the worker).
    for (const c of checkpoints) {
      const summary =
        typeof c.checkpoint_data.summary === "string"
          ? c.checkpoint_data.summary
          : typeof c.checkpoint_data.status === "string"
          ? c.checkpoint_data.status
          : null;
      list.push({
        id: c.id,
        at: c.created_at,
        icon: "📍",
        color: "#38bdf8",
        text: `${agentName(c.agent_id)} reportou progresso${summary ? `: ${summary.slice(0, 90)}` : ""}`,
        detail: JSON.stringify(c.checkpoint_data, null, 2),
        who: c.agent_id,
      });
    }

    // 4. Messages (durable conversation).
    for (const m of messages) {
      const kind =
        m.message_type === "direct_message"
          ? "🔴 mensagem direta"
          : m.message_type === "queued_note"
          ? "🟡 nota agendada"
          : m.message_type === "review_feedback"
          ? "🛡️ feedback de revisão"
          : "↔️ mensagem";
      list.push({
        id: m.id,
        at: m.created_at,
        icon: "💬",
        color: "#a855f7",
        text: `${m.from_agent_id ? agentName(m.from_agent_id) : "Você"} → ${agentName(m.to_agent_id)} (${kind})`,
        sub: m.body.slice(0, 110) + (m.body.length > 110 ? "…" : ""),
        detail: m.body.length > 110 ? m.body : undefined,
        who: m.from_agent_id ?? undefined,
      });
    }

    return list.sort((a, b) => (a.at < b.at ? -1 : 1));
  }, [task, events, checkpoints, messages, detailed, agentName]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500">
          {entries.length} evento{entries.length !== 1 ? "s" : ""} · do mais antigo ao mais recente
        </span>
        <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => setDetailed(e.target.checked)}
            className="accent-blue-500"
          />
          Modo detalhado (turnos, ferramentas, sistema)
        </label>
      </div>

      <div className="relative pl-4">
        {/* vertical rail */}
        <span className="absolute left-[5px] top-1 bottom-1 w-px" style={{ backgroundColor: "var(--border)" }} />
        <div className="space-y-0.5">
          {entries.map((entry) => {
            const isExpanded = expanded.has(entry.id);
            const expandable = !!entry.detail;
            return (
              <div key={entry.id} className="relative">
                <span
                  className="absolute -left-[14.5px] top-[7px] w-2 h-2 rounded-full border border-black"
                  style={{ backgroundColor: entry.color }}
                />
                <button
                  type="button"
                  onClick={() => expandable && toggleExpand(entry.id)}
                  className={`w-full text-left px-2 py-1 rounded transition-colors ${expandable ? "hover:bg-zinc-800/60" : ""}`}
                  style={{ background: "none", border: "none", cursor: expandable ? "pointer" : "default" }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[9px] text-zinc-500 font-mono flex-shrink-0 w-14">
                      {formatClock(entry.at)}
                    </span>
                    <span className="text-[11px] text-zinc-200 leading-snug">
                      <span className="mr-1">{entry.icon}</span>
                      {entry.text}
                      {expandable && (
                        <span className="text-[9px] text-zinc-500 ml-1">{isExpanded ? "▴ recolher" : "▾ detalhes"}</span>
                      )}
                    </span>
                  </div>
                  {entry.sub && (
                    <div className="text-[10px] text-zinc-500 ml-16 mt-0.5 leading-snug">{entry.sub}</div>
                  )}
                  {isExpanded && entry.detail && (
                    <pre
                      className="text-[10px] text-zinc-300 ml-16 mt-1 p-2 rounded whitespace-pre-wrap break-words font-mono max-h-56 overflow-y-auto"
                      style={{ backgroundColor: "rgba(0,0,0,0.45)", border: "1px solid var(--border)" }}
                    >
                      {entry.detail}
                    </pre>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
