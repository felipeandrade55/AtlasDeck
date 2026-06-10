"use client";

import { useMemo } from "react";
import { Radio, AlertTriangle, CheckCircle2, DollarSign, Rocket, BellRing } from "lucide-react";
import {
  ACTIVE_STATUSES,
  STATUS_COLORS,
  STATUS_LABELS,
  formatElapsed,
  stateLabel,
  type AgentInfo,
  type Task,
  type TaskStatus,
} from "./types";

export interface AgentLiveState {
  state: string; // working | thinking | idle | offline
  at: string; // ISO timestamp of the last signal
}

interface Props {
  agents: AgentInfo[];
  tasks: Task[];
  agentStates: Map<string, AgentLiveState>;
  onSelectTask: (taskId: string) => void;
}

const STATE_STYLE: Record<string, { color: string; pulse: boolean }> = {
  working: { color: "#22c55e", pulse: true },
  thinking: { color: "#0ea5e9", pulse: true },
  idle: { color: "#71717a", pulse: false },
  offline: { color: "#3f3f46", pulse: false },
};

/**
 * Top situational-awareness strip: global KPIs (what needs ME right now?)
 * plus one live chip per agent showing its current state and the mission it
 * is holding. The whole point is answering "who is doing what right now"
 * without scrolling.
 */
export function AgentRadar({ agents, tasks, agentStates, onSelectTask }: Props) {
  const kpis = useMemo(() => {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const awaiting = tasks.filter((t) => t.status === "review");
    const inFlight = tasks.filter(
      (t) => ACTIVE_STATUSES.includes(t.status) && t.status !== "review",
    );
    const done24h = tasks.filter(
      (t) => t.status === "done" && t.completed_at && new Date(t.completed_at).getTime() >= dayAgo,
    );
    const failed = tasks.filter((t) => t.status === "failed");
    const costCents = tasks.reduce((acc, t) => acc + (t.cost_cents || 0), 0);
    return { awaiting, inFlight, done24h, failed, costCents };
  }, [tasks]);

  // Most recent active task per agent — what the agent is "holding" now.
  const currentTaskByAgent = useMemo(() => {
    const map = new Map<string, Task>();
    const active = tasks
      .filter((t) => t.assigned_to && ACTIVE_STATUSES.includes(t.status))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (const t of active) map.set(t.assigned_to!, t); // later (newer) wins
    return map;
  }, [tasks]);

  const activeCountByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (!t.assigned_to || !ACTIVE_STATUSES.includes(t.status)) continue;
      map.set(t.assigned_to, (map.get(t.assigned_to) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  return (
    <div
      className="rounded-xl px-3 py-2.5 space-y-2.5"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* KPI strip */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 mr-1">
          <Radio className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Radar</span>
        </div>

        <button
          type="button"
          onClick={() => kpis.awaiting[0] && onSelectTask(kpis.awaiting[0].id)}
          disabled={kpis.awaiting.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-transform hover:scale-[1.03] disabled:cursor-default disabled:hover:scale-100"
          style={{
            backgroundColor: kpis.awaiting.length ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${kpis.awaiting.length ? "rgba(245,158,11,0.5)" : "var(--border)"}`,
            color: kpis.awaiting.length ? "#fbbf24" : "#71717a",
            cursor: kpis.awaiting.length ? "pointer" : "default",
          }}
          title={kpis.awaiting.length ? "Clique para abrir a primeira entrega pendente" : "Nada aguardando sua aprovação"}
        >
          <BellRing className={`w-3.5 h-3.5 ${kpis.awaiting.length ? "animate-pulse" : ""}`} />
          {kpis.awaiting.length} aguardando você
        </button>

        <Kpi icon={<Rocket className="w-3 h-3" />} label="em voo" value={kpis.inFlight.length} color="#38bdf8" />
        <Kpi icon={<CheckCircle2 className="w-3 h-3" />} label="entregues 24h" value={kpis.done24h.length} color="#4ade80" />
        {kpis.failed.length > 0 && (
          <Kpi icon={<AlertTriangle className="w-3 h-3" />} label="falhas" value={kpis.failed.length} color="#f87171" />
        )}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500" title="custo acumulado de todas as missões listadas">
          <DollarSign className="w-3 h-3" />
          {(kpis.costCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "USD" })} total
        </span>
      </div>

      {/* Agent chips */}
      <div className="flex flex-wrap gap-1.5">
        {agents.map((a) => {
          const live = agentStates.get(a.id);
          const state = live?.state ?? "offline";
          const style = STATE_STYLE[state] ?? STATE_STYLE.offline;
          const current = currentTaskByAgent.get(a.id);
          const count = activeCountByAgent.get(a.id) ?? 0;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => current && onSelectTask(current.id)}
              disabled={!current}
              className="flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-transform hover:-translate-y-0.5 disabled:hover:translate-y-0"
              style={{
                backgroundColor: `${a.color ?? "#6366f1"}10`,
                border: `1px solid ${a.color ?? "#6366f1"}35`,
                cursor: current ? "pointer" : "default",
                opacity: state === "offline" && !current ? 0.55 : 1,
              }}
              title={
                current
                  ? `${STATUS_LABELS[current.status as TaskStatus]} · ${current.title}`
                  : `${a.name} sem missão ativa`
              }
            >
              <span className="relative flex-shrink-0 text-base leading-none">
                {a.emoji ?? "🤖"}
                <span
                  className={`absolute -bottom-0.5 -right-1 w-2 h-2 rounded-full border border-black ${style.pulse ? "animate-pulse" : ""}`}
                  style={{ backgroundColor: style.color }}
                />
              </span>
              <span className="flex flex-col min-w-0">
                <span className="text-[10px] font-bold text-white leading-tight">
                  {a.name}
                  {count > 1 && <span className="text-zinc-400 font-normal"> ×{count}</span>}
                  <span className="font-normal" style={{ color: style.color }}>
                    {" "}· {stateLabel(state)}
                  </span>
                </span>
                <span className="text-[9px] text-zinc-400 truncate max-w-[180px] leading-tight">
                  {current ? (
                    <>
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
                        style={{ backgroundColor: STATUS_COLORS[current.status as TaskStatus] }}
                      />
                      {current.title || current.prompt.slice(0, 40)}
                      {current.started_at && (
                        <span className="text-zinc-500"> · {formatElapsed(Date.now() - new Date(current.started_at).getTime())}</span>
                      )}
                    </>
                  ) : (
                    "sem missão ativa"
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <span
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold"
      style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color }}
    >
      {icon}
      {value} <span className="text-zinc-500 font-normal">{label}</span>
    </span>
  );
}
