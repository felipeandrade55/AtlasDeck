"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Filter } from "lucide-react";
import { type LiveEvent } from "./types";

interface Props {
  events: LiveEvent[];
  onSelectTask: (taskId: string) => void;
}

/**
 * Sliding right-side feed of SSE events. Filterable by type; each entry
 * shows a colored dot + agent + task + short payload preview. Clicking an
 * event that carries a task_id selects that task in the kanban above.
 *
 * We intentionally render at most ~80 most recent events so the feed stays
 * snappy — anything older is in the SQLite log if the user wants to dig.
 */
export function LiveActivityFeed({ events, onSelectTask }: Props) {
  const [filter, setFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const visible = filter ? events.filter((e) => e.event_type === filter) : events;
    // Newest first for visual scan, capped at 80
    return [...visible].reverse().slice(0, 80);
  }, [events, filter]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.event_type);
    return Array.from(set).sort();
  }, [events]);

  return (
    <div className="rounded-xl p-3 h-full flex flex-col" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
          Live Activity ({events.length})
        </h4>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-zinc-500" />
          <select
            value={filter ?? ""}
            onChange={(e) => setFilter(e.target.value || null)}
            className="text-[10px] bg-zinc-900 border rounded px-1.5 py-0.5 text-zinc-300 outline-none"
            style={{ borderColor: "var(--border)" }}
          >
            <option value="">all</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 pr-1">
        {filtered.length === 0 && (
          <div className="text-center py-8 text-[10px] text-zinc-500">
            Sem eventos ainda. Delegue uma task pra começar.
          </div>
        )}
        {filtered.map((e) => {
          const color = colorFor(e.event_type);
          const summary = describe(e);
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => e.task_id && onSelectTask(e.task_id)}
              disabled={!e.task_id}
              className="w-full text-left px-2 py-1 rounded flex items-center gap-1.5 transition-colors hover:bg-zinc-800 disabled:cursor-default disabled:hover:bg-transparent"
              style={{ background: "none", border: "none" }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-[9px] text-zinc-500 font-mono w-12 flex-shrink-0">
                {new Date(e.created_at).toLocaleTimeString().slice(0, 8)}
              </span>
              <span className="text-[10px] text-zinc-300 truncate min-w-0 flex-1">{summary}</span>
              {e.task_id && <ChevronRight className="w-3 h-3 text-zinc-600 flex-shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function colorFor(type: string): string {
  if (type === "task.delegated") return "#a855f7";
  if (type.startsWith("task.")) return "#3b82f6";
  if (type.startsWith("mailbox.")) return "#a855f7";
  if (type.startsWith("agent.")) return "#10b981";
  if (type.startsWith("dispatcher.")) return "#f59e0b";
  if (type.startsWith("chat.")) return "#ec4899";
  return "#71717a";
}

function describe(e: LiveEvent): string {
  const tail = e.task_id ? `· ${e.task_id.slice(0, 8)}` : "";
  switch (e.event_type) {
    case "task.created":
      return `📥 nova task → ${e.payload.title ?? ""} ${tail}`.trim();
    case "task.delegated":
      return `🔀 ${e.payload.delegated_by ?? "main"} → ${e.payload.assigned_to ?? "?"}: ${String(e.payload.title ?? "").slice(0, 50)}`.trim();
    case "task.status_changed":
      return `🔄 ${e.payload.from} → ${e.payload.to} · ${e.payload.title ?? ""}`.trim();
    case "task.checkpoint":
      return `📍 ${e.agent_id ?? "?"} checkpoint ${tail}`;
    case "task.completed":
      return `✅ completou ${tail}`;
    case "task.reviewed":
      return `🛡️ review: ${e.payload.verdict} ${tail}`;
    case "task.approved":
      return `${e.payload.approved ? "👍 aprovou" : "👎 rejeitou"} ${tail}`;
    case "mailbox.message": {
      const t = e.payload.message_type;
      const icon = t === "direct_message" ? "🔴" : t === "queued_note" ? "🟡" : t === "review_feedback" ? "🛡️" : "↔️";
      return `${icon} ${e.payload.from ?? "user"} → ${e.payload.to}: ${String(e.payload.preview ?? "").slice(0, 60)}`;
    }
    case "agent.heartbeat":
      return `💓 ${e.agent_id} ${e.payload.state}`;
    case "agent.state_changed":
      return `🎭 ${e.agent_id}: ${e.payload.from ?? "—"} → ${e.payload.to}`;
    case "dispatcher.run":
      return `⚙️ dispatcher: ${e.payload.dispatched} disp, ${e.payload.paused} paused`;
    case "chat.turn_started":
      return `💬 ${e.agent_id ?? "?"} começou: ${String(e.payload.preview ?? "").slice(0, 60)}`;
    case "chat.tool_use":
      return `🔧 ${e.agent_id ?? "?"} → ${e.payload.tool}${e.payload.input_preview ? ` (${String(e.payload.input_preview).slice(0, 40)})` : ""}`;
    case "chat.turn_completed": {
      const ok = e.payload.ok;
      const dur = typeof e.payload.duration_ms === "number" ? `${(e.payload.duration_ms / 1000).toFixed(1)}s` : "";
      const tokens = (e.payload.tokensIn as number ?? 0) + (e.payload.tokensOut as number ?? 0);
      return `${ok ? "✅" : "⚠️"} turno ${ok ? "ok" : "vazio"} · ${dur}${tokens ? ` · ${tokens} tok` : ""}`;
    }
    default:
      return `${e.event_type} ${tail}`;
  }
}
