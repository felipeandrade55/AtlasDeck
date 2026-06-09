"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, LayoutGrid, Layers } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import { MissionGroups } from "./MissionGroups";
import { MissionTree } from "./MissionTree";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { LiveActivityFeed } from "./LiveActivityFeed";
import { type LiveEvent, type Task, type TaskStatus } from "./types";

interface Props {
  agents: Array<{ id: string; name: string; emoji?: string; color?: string }>;
}

/**
 * Container for the Live Mission tab. Owns three pieces of state:
 *
 *   1. tasks[]    — the full task universe (kanban + dependency graph use this)
 *   2. events[]   — recent SSE events (activity feed + cache-busting cues)
 *   3. selectedId — currently-focused task id
 *
 * Refresh strategy:
 *   - On mount: GET /api/tasks (full bootstrap) + open SSE /api/agents/live
 *   - On every SSE event that touches tasks: targeted refetch of /api/tasks
 *     (cheap + keeps the kanban canonical) — the alternative of patching
 *     in-place from the event payload duplicates server-side state machine
 *     logic in the client, which is exactly the bug we want to avoid.
 *   - SSE drops are handled by EventSource's native auto-reconnect; the
 *     replay window on /api/agents/live makes sure we don't miss anything.
 */
export function LiveMissionTab({ agents }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [viewMode, setViewMode] = useState<"status" | "mission">("status");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTaskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const fetchTasks = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (filterAgent) params.set("assigned_to", filterAgent);
      const res = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [filterAgent]);

  // Debounce refetches: when several events fire in quick succession (e.g.
  // a decompose that creates 4 tasks), we only want one GET to land.
  const scheduleRefresh = useCallback(() => {
    if (refreshTaskTimer.current) clearTimeout(refreshTaskTimer.current);
    refreshTaskTimer.current = setTimeout(() => {
      void fetchTasks();
    }, 300);
  }, [fetchTasks]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    // EventSource doesn't accept custom headers — auth cookie travels
    // automatically with the request because /api/agents/live is same-origin.
    const es = new EventSource(`/api/agents/live?replay=80`);
    sourceRef.current = es;

    es.addEventListener("event", (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as LiveEvent;
        setEvents((prev) => {
          // De-dupe: events with the same id can show up twice (replay +
          // live fire-through) when the server publishes between SQLite
          // insert and the SSE emit attaching.
          if (prev.some((e) => e.id === parsed.id)) return prev;
          // Keep last 500 in memory; the SQLite log is the long-tail source.
          const next = [...prev, parsed];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
        if (parsed.event_type.startsWith("task.")) {
          scheduleRefresh();
        }
      } catch {
        // ignore malformed frames
      }
    });

    es.addEventListener("connected", () => {
      // optional: surface "connected" badge somewhere later
    });

    es.onerror = () => {
      // Native auto-reconnect will retry — log only in dev.
      if (process.env.NODE_ENV === "development") {
        console.warn("[live-mission] SSE error, EventSource will reconnect");
      }
    };

    return () => {
      es.close();
      if (refreshTaskTimer.current) clearTimeout(refreshTaskTimer.current);
    };
  }, [scheduleRefresh]);

  const selectedTask = useMemo(
    () => (selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null),
    [tasks, selectedId],
  );

  const handleStatusChange = useCallback(
    async (taskId: string, nextStatus: TaskStatus) => {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        console.error("[live-mission] status change failed:", await res.text());
      }
      // SSE will surface the change; still kick a quick refetch in case
      // the user pulled this PATCH manually rather than via a tool.
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  if (loading) {
    return (
      <div
        className="rounded-xl p-8 flex items-center justify-center text-xs text-zinc-500"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        Carregando Live Mission…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header: filters + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Filtrar por agente:</span>
        <select
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value)}
          className="text-[11px] bg-zinc-900 border rounded px-2 py-1 text-zinc-300 outline-none"
          style={{ borderColor: "var(--border)" }}
        >
          <option value="">todos</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji ?? "🤖"} {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void fetchTasks()}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded text-zinc-300 hover:bg-zinc-800"
          style={{ background: "none", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>

        {/* View toggle: por status (kanban) vs por missão (agrupado) */}
        <div className="flex items-center rounded border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setViewMode("status")}
            className="flex items-center gap-1 text-[11px] px-2 py-1 transition-colors"
            style={{
              background: viewMode === "status" ? "var(--accent)" : "transparent",
              color: viewMode === "status" ? "white" : "var(--text-muted)",
              border: "none",
              cursor: "pointer",
            }}
          >
            <LayoutGrid className="w-3 h-3" />
            Status
          </button>
          <button
            type="button"
            onClick={() => setViewMode("mission")}
            className="flex items-center gap-1 text-[11px] px-2 py-1 transition-colors"
            style={{
              background: viewMode === "mission" ? "var(--accent)" : "transparent",
              color: viewMode === "mission" ? "white" : "var(--text-muted)",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Layers className="w-3 h-3" />
            Missão
          </button>
        </div>

        <span className="text-[10px] text-zinc-500 ml-auto">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""} · {events.length} eventos
        </span>
      </div>

      {/* Árvore da missão (orquestração ao vivo) */}
      <MissionTree tasks={tasks} agents={agents} onSelectTask={setSelectedId} />

      {/* Board: por status (kanban) ou por missão (agrupado) */}
      {viewMode === "status" ? (
        <KanbanBoard
          tasks={tasks}
          selectedTaskId={selectedId}
          onSelectTask={setSelectedId}
          onStatusChange={handleStatusChange}
        />
      ) : (
        <MissionGroups tasks={tasks} selectedTaskId={selectedId} onSelectTask={setSelectedId} />
      )}

      {/* Detail + Activity Feed below */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          {selectedTask ? (
            <TaskDetailPanel
              task={selectedTask}
              allTasks={tasks}
              onMutated={scheduleRefresh}
              onSelectTask={setSelectedId}
            />
          ) : (
            <div
              className="rounded-xl p-6 text-center text-xs text-zinc-500"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              Selecione uma task no kanban acima pra ver detalhes + dependency graph + ações inline.
            </div>
          )}
        </div>
        <div className="lg:col-span-1 min-h-[400px]">
          <LiveActivityFeed events={events} onSelectTask={setSelectedId} />
        </div>
      </div>
    </div>
  );
}
