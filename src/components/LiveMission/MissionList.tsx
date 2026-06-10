"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  ACTIVE_STATUSES,
  STATUS_COLUMNS,
  STATUS_COLORS,
  STATUS_LABELS,
  formatElapsed,
  type AgentInfo,
  type Task,
  type TaskStatus,
} from "./types";

interface Props {
  tasks: Task[];
  agents: AgentInfo[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

type GroupKey = "awaiting" | "active" | "done" | "problem";

const GROUPS: Array<{ key: GroupKey; label: string; icon: string }> = [
  { key: "awaiting", label: "Aguardando você", icon: "🔔" },
  { key: "active", label: "Em andamento", icon: "🚀" },
  { key: "done", label: "Concluídas", icon: "✅" },
  { key: "problem", label: "Falhas e canceladas", icon: "⚠️" },
];

function groupOf(t: Task): GroupKey {
  if (t.status === "review") return "awaiting";
  if (ACTIVE_STATUSES.includes(t.status)) return "active";
  if (t.status === "done") return "done";
  return "problem";
}

/**
 * Master list of missions (left rail). Replaces the 7-column kanban: instead
 * of mostly-empty columns, every mission is a row with a mini pipeline
 * stepper showing exactly where it is. Grouped by what matters to the user:
 * "needs my approval" always floats to the top.
 */
export function MissionList({ tasks, agents, selectedTaskId, onSelectTask }: Props) {
  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(new Set());

  const agentById = useMemo(() => {
    const m = new Map<string, AgentInfo>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = tasks.filter((t) => {
      if (filterAgent && t.assigned_to !== filterAgent && t.delegated_by !== filterAgent) return false;
      if (q && !`${t.title} ${t.prompt}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const map: Record<GroupKey, Task[]> = { awaiting: [], active: [], done: [], problem: [] };
    for (const t of visible) map[groupOf(t)].push(t);
    // Newest first inside each group — recency is what the user scans for.
    for (const key of Object.keys(map) as GroupKey[]) {
      map[key].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    return map;
  }, [tasks, search, filterAgent]);

  const toggle = (key: GroupKey) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      className="rounded-xl flex flex-col min-h-0 h-full"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* Search + agent filter */}
      <div className="p-2 space-y-1.5 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="relative">
          <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar missão…"
            className="w-full pl-6 pr-2 py-1.5 rounded text-[11px] outline-none bg-zinc-900 border text-white"
            style={{ borderColor: "var(--border)" }}
          />
        </div>
        <select
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value)}
          className="w-full text-[11px] bg-zinc-900 border rounded px-2 py-1 text-zinc-300 outline-none"
          style={{ borderColor: "var(--border)" }}
        >
          <option value="">Todos os agentes</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji ?? "🤖"} {a.name}
            </option>
          ))}
        </select>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-2 min-h-0">
        {GROUPS.map(({ key, label, icon }) => {
          const items = grouped[key];
          if (items.length === 0 && (key === "problem" || key === "awaiting")) return null;
          const isCollapsed = collapsed.has(key);
          const shown = key === "done" ? items.slice(0, 30) : items;
          return (
            <div key={key}>
              <button
                type="button"
                onClick={() => toggle(key)}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-zinc-800/60 transition-colors"
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3 h-3 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-zinc-500" />
                )}
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  {icon} {label}
                </span>
                <span
                  className={`ml-auto text-[10px] font-bold px-1.5 rounded-full ${
                    key === "awaiting" && items.length > 0 ? "text-amber-300 bg-amber-500/15" : "text-zinc-500"
                  }`}
                >
                  {items.length}
                </span>
              </button>
              {!isCollapsed && (
                <div className="space-y-1 mt-1">
                  {items.length === 0 && (
                    <div className="text-[10px] text-zinc-600 text-center py-2">— vazio —</div>
                  )}
                  {shown.map((t) => (
                    <MissionRow
                      key={t.id}
                      task={t}
                      agentById={agentById}
                      selected={t.id === selectedTaskId}
                      isSubtask={!!t.parent_task_id}
                      onSelect={() => onSelectTask(t.id)}
                    />
                  ))}
                  {shown.length < items.length && (
                    <div className="text-[10px] text-zinc-600 text-center py-1">
                      + {items.length - shown.length} mais antigas (use a busca)
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MissionRow({
  task,
  agentById,
  selected,
  isSubtask,
  onSelect,
}: {
  task: Task;
  agentById: Map<string, AgentInfo>;
  selected: boolean;
  isSubtask: boolean;
  onSelect: () => void;
}) {
  const color = STATUS_COLORS[task.status as TaskStatus];
  const emoji = (id: string | null) => (id ? agentById.get(id)?.emoji ?? "🤖" : null);
  const name = (id: string | null) => (id ? agentById.get(id)?.name ?? id : null);
  const elapsed = task.completed_at
    ? formatElapsed(new Date(task.completed_at).getTime() - new Date(task.created_at).getTime())
    : formatElapsed(Date.now() - new Date(task.created_at).getTime());

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-2 py-1.5 rounded-lg transition-all hover:-translate-y-px"
      style={{
        backgroundColor: selected ? "rgba(59,130,246,0.16)" : "rgba(0,0,0,0.35)",
        border: `1px solid ${selected ? "rgba(59,130,246,0.6)" : "var(--border)"}`,
        cursor: "pointer",
      }}
    >
      <div className="flex items-start gap-1.5">
        {isSubtask && <span className="text-[9px] text-zinc-500 mt-0.5" title="subtarefa">↳</span>}
        <span className="text-[11px] font-semibold text-white leading-tight line-clamp-2 flex-1">
          {task.title || task.prompt.slice(0, 60)}
        </span>
        {task.status === "review" && (
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0 mt-1" title="aguardando sua aprovação" />
        )}
        {task.user_approved === true && <span className="text-[10px] flex-shrink-0">👍</span>}
        {task.user_approved === false && <span className="text-[10px] flex-shrink-0">👎</span>}
      </div>

      {/* Who: delegation chain */}
      <div className="flex items-center gap-1 mt-1 text-[9px] text-zinc-400 truncate">
        {task.delegated_by && (
          <>
            <span>{emoji(task.delegated_by)} {name(task.delegated_by)}</span>
            <span className="text-zinc-600">→</span>
          </>
        )}
        <span>{emoji(task.assigned_to)} {name(task.assigned_to) ?? "sem agente"}</span>
        <span className="ml-auto flex-shrink-0 text-zinc-500">
          {elapsed}
          {task.cost_cents > 0 && ` · ${task.cost_cents}¢`}
        </span>
      </div>

      {/* Where: mini pipeline stepper */}
      <div className="flex items-center gap-1 mt-1.5">
        {task.status === "failed" || task.status === "cancelled" ? (
          <span
            className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-px rounded"
            style={{ backgroundColor: `${color}25`, color }}
          >
            {STATUS_LABELS[task.status]}
          </span>
        ) : (
          <>
            {STATUS_COLUMNS.map((s, i) => {
              const currentIdx = STATUS_COLUMNS.indexOf(task.status);
              const reached = i <= currentIdx;
              const isCurrent = i === currentIdx;
              return (
                <span
                  key={s}
                  title={STATUS_LABELS[s]}
                  className="h-1 rounded-full flex-1 transition-colors"
                  style={{
                    backgroundColor: reached ? (isCurrent ? color : `${color}66`) : "rgba(255,255,255,0.08)",
                    boxShadow: isCurrent ? `0 0 6px ${color}` : undefined,
                  }}
                />
              );
            })}
            <span className="text-[9px] font-semibold flex-shrink-0" style={{ color }}>
              {STATUS_LABELS[task.status]}
            </span>
          </>
        )}
      </div>
    </button>
  );
}
