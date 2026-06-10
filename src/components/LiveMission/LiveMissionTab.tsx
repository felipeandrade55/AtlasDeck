"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Crosshair } from "lucide-react";
import { AgentRadar, type AgentLiveState } from "./AgentRadar";
import { MissionList } from "./MissionList";
import { MissionDetail } from "./MissionDetail";
import { LiveActivityFeed } from "./LiveActivityFeed";
import { ACTIVE_STATUSES, type AgentInfo, type LiveEvent, type Task } from "./types";

interface Props {
  agents: AgentInfo[];
}

/**
 * "Cockpit" container for the Live Mission tab. Three fixed zones built for
 * situational awareness:
 *
 *   ┌─ AgentRadar ──────────────────────────────────────────────┐
 *   │ who is doing what right now + what needs MY decision       │
 *   ├─ MissionList ─┬─ MissionDetail ────────┬─ ActivityFeed ───┤
 *   │ every mission │ timeline + deliverable │ humanized live   │
 *   │ w/ pipeline   │ + approval + chat      │ event stream     │
 *   └───────────────┴────────────────────────┴──────────────────┘
 *
 * Refresh strategy (unchanged from the previous design):
 *   - On mount: GET /api/tasks (full bootstrap) + open SSE /api/agents/live
 *   - On every task.* SSE event: debounced refetch of /api/tasks — patching
 *     client-side from payloads would duplicate the server state machine.
 *   - SSE drops are handled by EventSource auto-reconnect + replay window.
 */
export function LiveMissionTab({ agents }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTaskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const autoSelected = useRef(false);

  const fetchTasks = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tasks?limit=200`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

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
    // automatically because /api/agents/live is same-origin. Replay window
    // is generous so the radar can reconstruct agent states after a reload.
    const es = new EventSource(`/api/agents/live?replay=200`);
    sourceRef.current = es;

    es.addEventListener("event", (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as LiveEvent;
        setEvents((prev) => {
          // De-dupe: events with the same id can show up twice (replay +
          // live fire-through).
          if (prev.some((e) => e.id === parsed.id)) return prev;
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

    es.onerror = () => {
      if (process.env.NODE_ENV === "development") {
        console.warn("[live-mission] SSE error, EventSource will reconnect");
      }
    };

    return () => {
      es.close();
      if (refreshTaskTimer.current) clearTimeout(refreshTaskTimer.current);
    };
  }, [scheduleRefresh]);

  // Auto-focus on first load: what needs the user beats what's merely recent.
  useEffect(() => {
    if (autoSelected.current || loading || tasks.length === 0) return;
    autoSelected.current = true;
    const awaiting = tasks.find((t) => t.status === "review");
    const active = tasks
      .filter((t) => ACTIVE_STATUSES.includes(t.status))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const recent = [...tasks].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    setSelectedId((awaiting ?? active ?? recent)?.id ?? null);
  }, [loading, tasks]);

  // Live agent states for the radar, reconstructed from the event stream.
  const agentStates = useMemo(() => {
    const map = new Map<string, AgentLiveState>();
    for (const e of events) {
      if (!e.agent_id) continue;
      if (e.event_type === "agent.state_changed") {
        map.set(e.agent_id, { state: String(e.payload.to ?? "idle"), at: e.created_at });
      } else if (e.event_type === "agent.heartbeat") {
        map.set(e.agent_id, { state: String(e.payload.state ?? "idle"), at: e.created_at });
      }
    }
    // A state older than 10 minutes is stale — treat the agent as offline
    // rather than showing a frozen "working" forever.
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, s] of map) {
      if (new Date(s.at).getTime() < cutoff && s.state !== "offline") {
        map.set(id, { ...s, state: "offline" });
      }
    }
    return map;
  }, [events]);

  const selectedTask = useMemo(
    () => (selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null),
    [tasks, selectedId],
  );

  const awaitingTasks = useMemo(() => tasks.filter((t) => t.status === "review"), [tasks]);

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
      {/* Situational awareness strip */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <AgentRadar agents={agents} tasks={tasks} agentStates={agentStates} onSelectTask={setSelectedId} />
        </div>
        <button
          type="button"
          onClick={() => void fetchTasks()}
          className="flex items-center gap-1 text-[11px] px-2 py-2 rounded-xl text-zinc-300 hover:bg-zinc-800 flex-shrink-0"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", cursor: "pointer" }}
          title="Forçar atualização (o painel já atualiza sozinho via SSE)"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Cockpit: missions | detail | live feed */}
      <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)_320px] gap-3 xl:h-[calc(100vh-330px)] xl:min-h-[560px]">
        <div className="min-h-[300px] max-h-[420px] xl:max-h-none xl:h-full">
          <MissionList tasks={tasks} agents={agents} selectedTaskId={selectedId} onSelectTask={setSelectedId} />
        </div>

        <div className="min-h-[400px] xl:h-full">
          {selectedTask ? (
            <MissionDetail
              task={selectedTask}
              allTasks={tasks}
              agents={agents}
              onMutated={scheduleRefresh}
              onSelectTask={setSelectedId}
            />
          ) : (
            <div
              className="rounded-xl h-full flex flex-col items-center justify-center gap-3 p-8 text-center"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              <Crosshair className="w-8 h-8 text-zinc-700" />
              <div className="text-sm text-zinc-400 font-semibold">Nenhuma missão em foco</div>
              <div className="text-[11px] text-zinc-500 max-w-xs">
                Escolha uma missão na lista ao lado pra ver a linha do tempo completa — quem fez o quê, quando e por quê.
              </div>
              {awaitingTasks.length > 0 && (
                <div className="space-y-1 w-full max-w-sm">
                  {awaitingTasks.slice(0, 3).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className="w-full px-3 py-2 rounded-lg text-[11px] font-semibold text-amber-300 text-left hover:scale-[1.01] transition-transform"
                      style={{ backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.4)", cursor: "pointer" }}
                    >
                      🔔 Aguardando você: {t.title || t.prompt.slice(0, 50)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="min-h-[300px] max-h-[420px] xl:max-h-none xl:h-full">
          <LiveActivityFeed events={events} agents={agents} onSelectTask={setSelectedId} />
        </div>
      </div>
    </div>
  );
}
