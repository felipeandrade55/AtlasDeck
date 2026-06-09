"use client";

import { useMemo } from "react";
import { ArrowRight, Radio } from "lucide-react";
import { STATUS_COLORS, STATUS_LABELS, type Task, type TaskStatus } from "./types";

interface AgentInfo {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
}

interface Props {
  tasks: Task[];
  agents: AgentInfo[];
  onSelectTask: (taskId: string) => void;
}

// Statuses that count as "in flight" — a task being orchestrated right now.
const ACTIVE: TaskStatus[] = ["planning", "inbox", "assigned", "in_progress", "testing", "review"];

/**
 * Live orchestration strip above the kanban: shows each orchestrator
 * (Jarvis = main) and, branching out, the specialists currently handling
 * delegated tasks — with a live count and the latest task title. Gives the
 * user an at-a-glance "who is the swarm working through right now" view
 * instead of having to read the columns. Updates as tasks flow because the
 * parent refetches /api/tasks on every task.* event.
 */
export function MissionTree({ tasks, agents, onSelectTask }: Props) {
  const agentById = useMemo(() => {
    const m = new Map<string, AgentInfo>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  // orchestrator id -> (assignee id -> active delegated tasks)
  const tree = useMemo(() => {
    const byOrch = new Map<string, Map<string, Task[]>>();
    for (const t of tasks) {
      if (!t.delegated_by) continue;
      if (!ACTIVE.includes(t.status as TaskStatus)) continue;
      const assignee = t.assigned_to ?? "—";
      if (!byOrch.has(t.delegated_by)) byOrch.set(t.delegated_by, new Map());
      const inner = byOrch.get(t.delegated_by)!;
      if (!inner.has(assignee)) inner.set(assignee, []);
      inner.get(assignee)!.push(t);
    }
    return byOrch;
  }, [tasks]);

  const label = (id: string) => agentById.get(id)?.name ?? id;
  const emoji = (id: string) => agentById.get(id)?.emoji ?? "🤖";
  const colorOf = (id: string) => agentById.get(id)?.color ?? "#6366f1";

  const hasActive = tree.size > 0;

  return (
    <div
      className="rounded-xl p-3"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Radio className="w-3.5 h-3.5 text-purple-400" />
        <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
          Orquestração ao vivo
        </h4>
        {hasActive && (
          <span className="text-[10px] text-zinc-500">
            · {[...tree.values()].reduce((acc, m) => acc + [...m.values()].reduce((a, l) => a + l.length, 0), 0)} task(s) em voo
          </span>
        )}
      </div>

      {!hasActive ? (
        <div className="text-[11px] text-zinc-500 py-3 text-center">
          Nenhuma delegação ativa. Quando o Jarvis delegar para um especialista, a árvore aparece aqui em tempo real.
        </div>
      ) : (
        <div className="space-y-3">
          {[...tree.entries()].map(([orchId, assignees]) => (
            <div key={orchId} className="flex items-start gap-2">
              {/* Orchestrator node */}
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0"
                style={{
                  backgroundColor: `${colorOf(orchId)}1a`,
                  border: `1.5px solid ${colorOf(orchId)}55`,
                }}
              >
                <span className="text-base leading-none">{emoji(orchId)}</span>
                <span className="text-[11px] font-bold text-white">{label(orchId)}</span>
              </div>

              <ArrowRight className="w-4 h-4 text-zinc-600 mt-2 shrink-0" />

              {/* Specialist chips */}
              <div className="flex flex-wrap gap-1.5">
                {[...assignees.entries()].map(([assignee, list]) => {
                  const latest = list[list.length - 1];
                  const c = colorOf(assignee);
                  const st = (latest?.status as TaskStatus) ?? "inbox";
                  return (
                    <button
                      key={assignee}
                      type="button"
                      onClick={() => latest && onSelectTask(latest.id)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-left transition-transform hover:-translate-y-0.5"
                      style={{
                        backgroundColor: `${c}14`,
                        border: `1px solid ${c}40`,
                        cursor: "pointer",
                      }}
                      title={latest?.title || latest?.prompt}
                    >
                      <span className="text-sm leading-none">{emoji(assignee)}</span>
                      <span className="flex flex-col min-w-0">
                        <span className="text-[10px] font-semibold text-white truncate max-w-[140px]">
                          {label(assignee)}
                          {list.length > 1 && <span className="text-zinc-400"> ×{list.length}</span>}
                        </span>
                        <span className="flex items-center gap-1">
                          <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: STATUS_COLORS[st] }}
                          />
                          <span className="text-[9px] text-zinc-400 truncate max-w-[130px]">
                            {STATUS_LABELS[st]} · {(latest?.title || "").slice(0, 28) || "—"}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
