'use client';

/**
 * Shared data layer for every 3D office environment. Extracted 1:1 from
 * the original Office3D.tsx effects so Mission Control, Startup Campus and
 * the classic scene all consume the exact same state machine:
 *
 *   1. roster bootstrap+refresh from /api/office (30s)
 *   2. initial health snapshot from /api/agents/all/health
 *   3. live updates from the shared SSE bus (OfficeDataProvider)
 *   4. orchestrator focus rotation (review > delegating round-robin)
 *   5. focus projected into the main agent's visual state
 *
 * Positions are deliberately NOT part of this hook — where an agent sits
 * is each environment's layout concern.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { AGENTS } from '../../agentsConfig';
import type { AgentState, AgentStatus } from '../../agentsConfig';
import { useOfficeBus } from './OfficeDataProvider';

export interface OfficeAgent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  role: string;
}

/**
 * Normalize agent-health states + legacy aliases into the 7-state vocab.
 * agent-health writes "working"/"thinking"/etc. directly already, but the
 * legacy `/api/office` endpoint still returns "error" — treat it as `stuck`.
 */
export function normalizeStatus(raw: string): AgentStatus {
  switch (raw) {
    case 'idle':
    case 'thinking':
    case 'working':
    case 'delegating':
    case 'reviewing':
    case 'stuck':
    case 'offline':
      return raw;
    case 'in_progress':
      return 'working';
    case 'error':
      return 'stuck';
    default:
      return 'idle';
  }
}

export type TaskMap = Map<string, Map<string, string>>;

export function updateTaskMap(prev: TaskMap, agentId: string, taskId: string, status: string): TaskMap {
  const TERMINAL = new Set(['done', 'cancelled', 'failed']);
  const next = new Map(prev);
  const agentTasks = new Map(next.get(agentId) ?? new Map<string, string>());
  if (TERMINAL.has(status)) {
    agentTasks.delete(taskId);
  } else {
    agentTasks.set(taskId, status);
  }
  if (agentTasks.size === 0) next.delete(agentId);
  else next.set(agentId, agentTasks);
  return next;
}

/** Task statuses that count as "this specialist is busy right now". */
export const ACTIVE_TASK_STATUSES = new Set(['assigned', 'in_progress', 'testing', 'planning', 'review']);

const DEFAULT_AGENTS: OfficeAgent[] = AGENTS.map(({ id, name, emoji, color, role }) => ({
  id,
  name,
  emoji,
  color,
  role,
}));

export interface OfficeData {
  agents: OfficeAgent[];
  agentStates: Record<string, AgentState>;
  /** agent_id → (task_id → status) for in-flight tasks. */
  activeByAgent: TaskMap;
  orchestratorFocus: { agentId: string; reviewing: boolean } | null;
  /** Sorted ids of specialists with an active task (meeting candidates). */
  meetingParticipantIds: string[];
  /** Roster id of the orchestrator ('main'/'jarvis'), if present. */
  mainAgentId: string | null;
}

export function useOfficeData(): OfficeData {
  const bus = useOfficeBus();
  const [agents, setAgents] = useState<OfficeAgent[]>(DEFAULT_AGENTS);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [activeByAgent, setActiveByAgent] = useState<TaskMap>(new Map());
  const rotationIdx = useRef(0);
  const [orchestratorFocus, setOrchestratorFocus] = useState<{ agentId: string; reviewing: boolean } | null>(null);

  // 1. Bootstrap agent roster from /api/office (merges OpenClaw's
  //    openclaw.json with AtlasDeck's local meta). Refresh only every 30s —
  //    the swarm shape rarely changes; per-agent state comes through SSE.
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch('/api/office');
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.agents) || data.agents.length === 0) return;
        setAgents(
          data.agents.map((agent: Record<string, string>) => ({
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            role: agent.role,
          })),
        );
      } catch (err) {
        console.error('[useOfficeData] Failed to fetch agents:', err);
      }
    };
    fetchAgents();
    const interval = setInterval(fetchAgents, 30000);
    return () => clearInterval(interval);
  }, []);

  // 2. Seed initial health snapshot (so reloading the tab shows the right
  //    state immediately instead of every avatar starting "idle").
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agents/all/health', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data.health)) return;
        const next: Record<string, AgentState> = {};
        for (const h of data.health) {
          next[h.agent_id] = {
            id: h.agent_id,
            status: normalizeStatus(h.state),
            currentTask: h.current_task_id ?? undefined,
          };
        }
        setAgentStates((prev) => ({ ...next, ...prev }));
      } catch {
        // best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 3. Subscribe to the shared live event bus. Updates per-agent state in
  //    real time and maintains the active-tasks map used for focus/meeting.
  useEffect(() => {
    return bus.subscribe((e) => {
      // Track tasks-per-agent
      if (e.event_type === 'task.created' && e.agent_id && e.task_id) {
        const status = String(e.payload.status ?? 'inbox');
        setActiveByAgent((m) => updateTaskMap(m, e.agent_id!, e.task_id!, status));
      }
      if (e.event_type === 'task.status_changed' && e.agent_id && e.task_id) {
        const to = String(e.payload.to ?? '');
        setActiveByAgent((m) => updateTaskMap(m, e.agent_id!, e.task_id!, to));
      }

      // Track per-agent visual state from heartbeat / state_changed
      if (
        (e.event_type === 'agent.state_changed' || e.event_type === 'agent.heartbeat') &&
        e.agent_id
      ) {
        const rawState = String(e.payload.to ?? e.payload.state ?? 'idle');
        setAgentStates((prev) => ({
          ...prev,
          [e.agent_id!]: {
            id: e.agent_id!,
            status: normalizeStatus(rawState),
            currentTask: e.task_id ?? prev[e.agent_id!]?.currentTask,
          },
        }));
      }
    });
  }, [bus]);

  // 4. Drive the orchestrator's focus.
  //
  // - If any sub-agent has a task in `review`, Jarvis parks next to that
  //   desk (reviewing).
  // - Otherwise, if multiple agents are in-flight, rotate every 7s through
  //   them (delegating).
  // - Otherwise no focus.
  useEffect(() => {
    const tick = () => {
      const reviewees: string[] = [];
      const inFlight: string[] = [];
      for (const [agentId, tasks] of activeByAgent) {
        if (agentId === 'main' || agentId === 'jarvis') continue;
        let isReview = false;
        let isActive = false;
        for (const status of tasks.values()) {
          if (status === 'review') isReview = true;
          else if (['assigned', 'in_progress', 'testing', 'planning'].includes(status)) isActive = true;
        }
        if (isReview) reviewees.push(agentId);
        if (isActive) inFlight.push(agentId);
      }
      if (reviewees.length > 0) {
        setOrchestratorFocus({ agentId: reviewees[0], reviewing: true });
        return;
      }
      if (inFlight.length === 0) {
        setOrchestratorFocus(null);
        return;
      }
      inFlight.sort();
      const next = inFlight[rotationIdx.current % inFlight.length];
      rotationIdx.current = (rotationIdx.current + 1) % Math.max(1, inFlight.length);
      setOrchestratorFocus({ agentId: next, reviewing: false });
    };
    tick();
    const interval = setInterval(tick, 7000);
    return () => clearInterval(interval);
  }, [activeByAgent]);

  const mainAgentId = useMemo(
    () => agents.find((a) => a.id === 'main' || a.id === 'jarvis')?.id ?? null,
    [agents],
  );

  // 5. Project orchestrator focus into the main agent's visual state so
  //    the renderer treats it the same as any other state transition.
  //    Derived (not setState-in-effect): with focus, main shows
  //    delegating/reviewing; without it, a leftover delegating/reviewing
  //    collapses to idle — but a real working/thinking from SSE survives.
  const projectedStates = useMemo<Record<string, AgentState>>(() => {
    const mainId = mainAgentId ?? 'main';
    const cur = agentStates[mainId];
    if (!orchestratorFocus) {
      if (cur?.status === 'delegating' || cur?.status === 'reviewing') {
        return { ...agentStates, [mainId]: { id: mainId, status: 'idle' } };
      }
      return agentStates;
    }
    return {
      ...agentStates,
      [mainId]: {
        id: mainId,
        status: orchestratorFocus.reviewing ? 'reviewing' : 'delegating',
        focusAgentId: orchestratorFocus.agentId,
        currentTask: cur?.currentTask,
      },
    };
  }, [agentStates, orchestratorFocus, mainAgentId]);

  // Meeting candidates: specialists with at least one active task. The
  // ≥MEETING_MIN_PARTICIPANTS gate and seat assignment are layout concerns.
  const meetingParticipantIds = useMemo(() => {
    const ids: string[] = [];
    for (const a of agents) {
      if (a.id === 'main' || a.id === 'jarvis') continue;
      const tasks = activeByAgent.get(a.id);
      if (!tasks) continue;
      for (const st of tasks.values()) {
        if (ACTIVE_TASK_STATUSES.has(st)) {
          ids.push(a.id);
          break;
        }
      }
    }
    return ids;
  }, [agents, activeByAgent]);

  return { agents, agentStates: projectedStates, activeByAgent, orchestratorFocus, meetingParticipantIds, mainAgentId };
}
