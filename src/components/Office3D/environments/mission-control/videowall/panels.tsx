'use client';

/**
 * DOM panels rendered inside the videowall's single <Html> grid. Compact
 * versions of the app's dashboards — NOT the full pages (those carry
 * controls/diagnostics that don't belong on a wall display).
 *
 * Everything shares the CRT look defined in Videowall.tsx via the
 * `vw-panel` class.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LiveEvent, Task, TaskStatus } from '@/components/LiveMission/types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  describeEvent,
  formatElapsed,
} from '@/components/LiveMission/types';
import type { OfficeAgent } from '../../../shared/data/useOfficeData';
import type { AgentState } from '../../../agentsConfig';
import { STATUS_COLOR, STATUS_LABEL_PT } from '../../../shared/statusColors';
import type { OfficeBus } from '../../../shared/data/OfficeDataProvider';

/* ------------------------------------------------------------------ */
/* Mission (center panel)                                              */
/* ------------------------------------------------------------------ */

const MISSION_PRIORITY: TaskStatus[] = ['in_progress', 'testing', 'review', 'assigned', 'planning', 'inbox'];

export function MissionPanel({
  tasks,
  agents,
  agentStates,
}: {
  tasks: Task[];
  agents: OfficeAgent[];
  agentStates: Record<string, AgentState>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const mission = useMemo(() => {
    for (const status of MISSION_PRIORITY) {
      const candidates = tasks.filter((t) => t.status === status);
      if (candidates.length > 0) return candidates[0];
    }
    return null;
  }, [tasks]);

  const agentName = (id: string | null | undefined) =>
    agents.find((a) => a.id === id)?.name ?? id ?? '—';

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of agents) {
      const st = agentStates[a.id]?.status ?? 'idle';
      counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    return counts;
  }, [agents, agentStates]);

  const clock = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = new Date(now).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

  return (
    <div className="vw-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="vw-title">⬢ MISSÃO ATUAL</span>
        <span style={{ fontSize: 26, fontWeight: 700, color: '#7dd3fc', fontVariantNumeric: 'tabular-nums' }}>
          {clock}
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: -10, textTransform: 'capitalize' }}>{date}</div>

      {mission ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.25, color: '#f1f5f9' }}>
            {mission.title || mission.prompt.slice(0, 120)}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 99,
                background: `${STATUS_COLORS[mission.status]}26`,
                color: STATUS_COLORS[mission.status],
                fontWeight: 700,
              }}
            >
              {STATUS_LABELS[mission.status]}
            </span>
            <span style={{ color: '#94a3b8' }}>
              👤 {agentName(mission.assigned_to)}
            </span>
            <span style={{ color: '#94a3b8' }}>
              ⏱ {formatElapsed(now - new Date(mission.started_at ?? mission.created_at).getTime())}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#475569', fontSize: 20 }}>
          Nenhuma missão em andamento — frota em standby
        </div>
      )}

      <div>
        <div className="vw-title" style={{ marginBottom: 6 }}>FROTA</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Array.from(statusCounts.entries()).map(([status, count]) => (
            <span
              key={status}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                padding: '3px 10px',
                borderRadius: 6,
                background: 'rgba(15,23,42,0.8)',
                border: `1px solid ${STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#334155'}55`,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#64748b',
                }}
              />
              {count}× {STATUS_LABEL_PT[status as keyof typeof STATUS_LABEL_PT] ?? status}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kanban (left-top)                                                   */
/* ------------------------------------------------------------------ */

const KANBAN_COLUMNS: TaskStatus[] = ['inbox', 'assigned', 'in_progress', 'testing', 'review', 'done'];

export function KanbanMini({ tasks }: { tasks: Task[] }) {
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const t of tasks) {
      const list = m.get(t.status) ?? [];
      list.push(t);
      m.set(t.status, list);
    }
    return m;
  }, [tasks]);

  return (
    <div className="vw-panel">
      <div className="vw-title">▦ PIPELINE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
        {KANBAN_COLUMNS.map((status) => {
          const list = byStatus.get(status) ?? [];
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 96, color: STATUS_COLORS[status], fontWeight: 700 }}>
                {STATUS_LABELS[status]}
              </span>
              <span
                style={{
                  minWidth: 22,
                  textAlign: 'center',
                  fontWeight: 700,
                  background: `${STATUS_COLORS[status]}22`,
                  color: STATUS_COLORS[status],
                  borderRadius: 4,
                  padding: '1px 5px',
                }}
              >
                {list.length}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#94a3b8',
                }}
              >
                {list[0]?.title ?? ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live feed (right-top)                                               */
/* ------------------------------------------------------------------ */

// `bus` comes in as a prop (not context): React context does not cross the
// R3F Canvas boundary, and these panels render inside drei's <Html>.
export function FeedMini({ agents, bus }: { agents: OfficeAgent[]; bus: OfficeBus }) {
  const [events, setEvents] = useState<LiveEvent[]>(() => bus.getRecent().slice(-12));

  // Initial backlog comes from the useState initializer (bus is stable for
  // the provider's lifetime); the subscription appends from there.
  useEffect(() => {
    return bus.subscribe((e) => {
      // Heartbeats are too chatty for a wall display
      if (e.event_type === 'agent.heartbeat') return;
      setEvents((prev) => [...prev.slice(-11), e]);
    });
  }, [bus]);

  const agentName = (id: string | null | undefined) =>
    agents.find((a) => a.id === id)?.name ?? (id ? String(id) : '—');

  return (
    <div className="vw-panel">
      <div className="vw-title">☷ ATIVIDADE AO VIVO</div>
      <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 4, marginTop: 8, overflow: 'hidden' }}>
        {events
          .slice()
          .reverse()
          .map((e, i) => {
            const { icon, text } = describeEvent(e, agentName);
            return (
              <div
                key={`${e.id}-${i}`}
                style={{
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: i === 0 ? '#e2e8f0' : '#94a3b8',
                  opacity: Math.max(0.35, 1 - i * 0.08),
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {icon} {text}
              </div>
            );
          })}
        {events.length === 0 && <div style={{ fontSize: 12, color: '#475569' }}>Aguardando eventos…</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Costs (left-bottom)                                                 */
/* ------------------------------------------------------------------ */

interface CostSummary {
  today: number;
  thisMonth: number;
  budget: number;
}

export function CostsMini() {
  const [costs, setCosts] = useState<CostSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchCosts = async () => {
      try {
        const res = await fetch('/api/costs?collect=0');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && typeof data.today === 'number') {
          setCosts({ today: data.today, thisMonth: data.thisMonth ?? 0, budget: data.budget ?? 0 });
        }
      } catch {
        // wall display — fail silent
      }
    };
    fetchCosts();
    const interval = setInterval(fetchCosts, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const pct = costs && costs.budget > 0 ? Math.min(100, (costs.thisMonth / costs.budget) * 100) : null;

  return (
    <div className="vw-panel">
      <div className="vw-title">⚡ CONSUMO</div>
      {costs ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: '#94a3b8' }}>Hoje</span>
            <span style={{ fontWeight: 700, color: '#fbbf24' }}>${costs.today.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: '#94a3b8' }}>Mês</span>
            <span style={{ fontWeight: 700, color: '#f1f5f9' }}>${costs.thisMonth.toFixed(2)}</span>
          </div>
          {pct !== null && (
            <div>
              <div style={{ height: 6, background: '#1e293b', borderRadius: 99, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e',
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                {pct.toFixed(0)}% do orçamento (${costs.budget.toFixed(0)})
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>Sem dados de custo…</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts (right-bottom)                                               */
/* ------------------------------------------------------------------ */

export function AlertsMini({
  agents,
  agentStates,
  tasks,
}: {
  agents: OfficeAgent[];
  agentStates: Record<string, AgentState>;
  tasks: Task[];
}) {
  const stuckAgents = agents.filter((a) => agentStates[a.id]?.status === 'stuck');
  const reviewTasks = tasks.filter((t) => t.status === 'review');
  const hasAlerts = stuckAgents.length > 0 || reviewTasks.length > 0;

  return (
    <div className="vw-panel" style={hasAlerts ? { borderColor: 'rgba(239,68,68,0.5)' } : undefined}>
      <div className="vw-title" style={hasAlerts ? { color: '#f87171' } : undefined}>
        ⚠ ALERTAS
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, fontSize: 12 }}>
        {stuckAgents.map((a) => (
          <div key={a.id} style={{ color: '#f87171', fontWeight: 600 }}>
            🔴 {a.emoji} {a.name} está TRAVADO
          </div>
        ))}
        {reviewTasks.slice(0, 3).map((t) => (
          <div key={t.id} style={{ color: '#fdba74', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🛡️ Aguardando revisão: {t.title}
          </div>
        ))}
        {!hasAlerts && <div style={{ color: '#34d399' }}>✓ Todos os sistemas nominais</div>}
      </div>
    </div>
  );
}
