"use client";

import { useMemo, useState } from "react";
import { Activity, ChevronRight } from "lucide-react";
import {
  categorizeEvent,
  describeEvent,
  eventColor,
  formatClock,
  type AgentInfo,
  type EventCategory,
  type LiveEvent,
} from "./types";

interface Props {
  events: LiveEvent[];
  agents: AgentInfo[];
  onSelectTask: (taskId: string) => void;
}

const CATEGORY_CHIPS: Array<{ key: EventCategory | "all"; label: string }> = [
  { key: "all", label: "Tudo" },
  { key: "missao", label: "Missões" },
  { key: "agente", label: "Agentes" },
  { key: "chat", label: "Chat" },
  { key: "sistema", label: "Sistema" },
];

/**
 * Right-rail live feed. Every SSE event becomes a human-readable PT-BR
 * sentence (shared with the timeline via describeEvent) instead of raw
 * event-type codes. Filter chips group by what the user thinks in
 * (missões / agentes / chat / sistema), not by internal event names.
 */
export function LiveActivityFeed({ events, agents, onSelectTask }: Props) {
  const [category, setCategory] = useState<EventCategory | "all">("all");

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a]));
    return (id: string | null | undefined) => {
      if (!id) return "";
      const a = m.get(id);
      return a ? `${a.emoji ?? "🤖"} ${a.name}` : id;
    };
  }, [agents]);

  const filtered = useMemo(() => {
    const visible =
      category === "all" ? events : events.filter((e) => categorizeEvent(e.event_type) === category);
    // Newest first, capped so the DOM stays light.
    return [...visible].reverse().slice(0, 120);
  }, [events, category]);

  // Day separators: show the date when consecutive events cross midnight.
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

  return (
    <div
      className="rounded-xl flex flex-col min-h-0 h-full"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="p-2.5 border-b space-y-2" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-green-400" />
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            Atividade ao vivo
          </h4>
          <span className="text-[10px] text-zinc-600 ml-auto">{events.length} eventos</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {CATEGORY_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              className="px-2 py-0.5 rounded-full text-[10px] font-semibold transition-colors"
              style={{
                backgroundColor: category === c.key ? "var(--accent)" : "rgba(255,255,255,0.04)",
                color: category === c.key ? "white" : "var(--text-muted)",
                border: `1px solid ${category === c.key ? "var(--accent)" : "var(--border)"}`,
                cursor: "pointer",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-px min-h-0">
        {filtered.length === 0 && (
          <div className="text-center py-8 text-[10px] text-zinc-500">
            Sem eventos nessa categoria ainda.
          </div>
        )}
        {filtered.map((e, i) => {
          const { icon, text } = describeEvent(e, agentName);
          const color = eventColor(e.event_type);
          const prev = filtered[i - 1];
          const showDay = !prev || dayOf(prev.created_at) !== dayOf(e.created_at);
          return (
            <div key={e.id}>
              {showDay && (
                <div className="flex items-center gap-2 px-1 py-1">
                  <span className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
                  <span className="text-[9px] font-bold uppercase text-zinc-600">{dayOf(e.created_at)}</span>
                  <span className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
                </div>
              )}
              <button
                type="button"
                onClick={() => e.task_id && onSelectTask(e.task_id)}
                disabled={!e.task_id}
                className="w-full text-left px-1.5 py-1 rounded flex items-start gap-1.5 transition-colors hover:bg-zinc-800/70 disabled:cursor-default disabled:hover:bg-transparent group"
                style={{ background: "none", border: "none" }}
                title={e.task_id ? "Clique para focar essa missão" : undefined}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ backgroundColor: color }} />
                <span className="min-w-0 flex-1">
                  <span className="text-[11px] text-zinc-300 leading-snug block">
                    <span className="mr-1">{icon}</span>
                    {text}
                  </span>
                  <span className="text-[9px] text-zinc-600 font-mono">{formatClock(e.created_at)}</span>
                </span>
                {e.task_id && (
                  <ChevronRight className="w-3 h-3 text-zinc-600 flex-shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
