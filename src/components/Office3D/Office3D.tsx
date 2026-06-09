'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sky, Environment } from '@react-three/drei';
import { Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { Vector3, PCFShadowMap } from 'three';
import { AGENTS } from './agentsConfig';
import type { AgentState, AgentStatus } from './agentsConfig';
import AgentDesk from './AgentDesk';
import Floor from './Floor';
import Walls from './Walls';
import Lights from './Lights';
import AgentPanel from './AgentPanel';
import FileCabinet from './FileCabinet';
import Whiteboard from './Whiteboard';
import CoffeeMachine from './CoffeeMachine';
import PlantPot from './PlantPot';
import WallClock from './WallClock';
import FirstPersonControls from './FirstPersonControls';
import MovingAvatar from './MovingAvatar';
import MeetingTable from './MeetingTable';
import { MEETING_SEATS, MEETING_MIN_PARTICIPANTS, MEETING_TABLE_CENTER } from './meetingConfig';

/**
 * Normalize agent-health states + legacy aliases into the 7-state vocab.
 * agent-health writes "working"/"thinking"/etc. directly already, but the
 * legacy `/api/office` endpoint still returns "error" — treat it as `stuck`.
 */
function normalizeStatus(raw: string): AgentStatus {
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

type TaskMap = Map<string, Map<string, string>>;
function updateTaskMap(prev: TaskMap, agentId: string, taskId: string, status: string): TaskMap {
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
export default function Office3D() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [interactionModal, setInteractionModal] = useState<string | null>(null);
  const [controlMode, setControlMode] = useState<'orbit' | 'fps'>('orbit');
  const [avatarPositions, setAvatarPositions] = useState<Map<string, any>>(new Map());
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [dynamicAgents, setDynamicAgents] = useState<any[]>(AGENTS);

  /**
   * Tracks which tasks each agent currently has in flight (and the status
   * of each). Used to compute the orchestrator's `focusAgentId` — i.e.
   * whose desk Jarvis should walk over to next:
   *
   *   - Highest priority: any task in `review` → stand next to that desk
   *     (state = reviewing).
   *   - Otherwise, rotate every ~7s through agents with `in_progress` /
   *     `assigned` tasks (state = delegating).
   *   - No active tasks → idle wander.
   */
  const [activeByAgent, setActiveByAgent] = useState<Map<string, Map<string, string>>>(new Map());
  const rotationIdx = useRef(0);
  const [orchestratorFocus, setOrchestratorFocus] = useState<{ agentId: string; reviewing: boolean } | null>(null);

  // 1. Bootstrap agent list + desk positions (same shape as before — driven
  //    by /api/office which already merges OpenClaw's openclaw.json with
  //    AtlasDeck's local meta).
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch('/api/office');
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.agents) || data.agents.length === 0) return;
        const presetPositions: [number, number, number][] = [
          [0, 0, 0],
          [-4, 0, -3],
          [4, 0, -3],
          [-4, 0, 3],
          [4, 0, 3],
          [0, 0, 6],
        ];
        const mapped = data.agents.map((agent: any, idx: number) => {
          let posIndex = idx;
          if (agent.id === 'main') posIndex = 0;
          else if (idx === 0) posIndex = 1;
          const position = presetPositions[posIndex % presetPositions.length] || [
            Math.sin(idx * 2) * 6, 0, Math.cos(idx * 2) * 6,
          ];
          return {
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            role: agent.role,
            position,
          };
        });
        setDynamicAgents(mapped);
      } catch (err) {
        console.error('[Office3D] Failed to fetch agents:', err);
      }
    };
    fetchAgents();
    // Refresh only every 30s — the swarm shape rarely changes; per-agent
    // state comes through the SSE stream below.
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

  // 3. Subscribe to the live event bus. Updates per-agent state in real
  //    time and maintains the active-tasks map used for orchestrator focus.
  useEffect(() => {
    const es = new EventSource('/api/agents/live?replay=80');
    es.addEventListener('event', (msg) => {
      try {
        const e = JSON.parse((msg as MessageEvent).data) as {
          event_type: string;
          task_id: string | null;
          agent_id: string | null;
          payload: Record<string, unknown>;
        };

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
      } catch {
        // ignore malformed frames
      }
    });
    es.onerror = () => {
      // Native auto-reconnect — log only in dev
      if (process.env.NODE_ENV === 'development') {
        console.warn('[Office3D] SSE error, EventSource will reconnect');
      }
    };
    return () => es.close();
  }, []);

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

  // 5. Project orchestrator focus into the main agent's visual state so
  //    the renderer treats it the same as any other state transition.
  useEffect(() => {
    setAgentStates((prev) => {
      const mainId = dynamicAgents.find((a) => a.id === 'main')?.id ?? 'main';
      const cur = prev[mainId];
      if (!orchestratorFocus) {
        // Don't trample a real `working`/`thinking` state pushed by SSE —
        // only clear orchestrator-derived focus statuses.
        if (cur?.status === 'delegating' || cur?.status === 'reviewing') {
          return { ...prev, [mainId]: { id: mainId, status: 'idle' } };
        }
        return prev;
      }
      return {
        ...prev,
        [mainId]: {
          id: mainId,
          status: orchestratorFocus.reviewing ? 'reviewing' : 'delegating',
          focusAgentId: orchestratorFocus.agentId,
          currentTask: cur?.currentTask,
        },
      };
    });
  }, [orchestratorFocus, dynamicAgents]);

  /** Map of agent_id → desk Vector3 (used by MovingAvatar for anchored targets). */
  const deskPositions = useMemo<Map<string, Vector3>>(() => {
    const map = new Map<string, Vector3>();
    for (const a of dynamicAgents) {
      map.set(a.id, new Vector3(a.position[0], 0, a.position[2]));
    }
    return map;
  }, [dynamicAgents]);

  /**
   * Meeting logic: when ≥ MEETING_MIN specialists have a task in flight at
   * the same time, the team convenes at the meeting table. The orchestrator
   * (main/jarvis) takes the head seat; each active specialist gets the next
   * seat. Returns a map agent_id → seat tuple consumed by MovingAvatar.
   */
  const ACTIVE_TASK_STATUSES = useMemo(
    () => new Set(['assigned', 'in_progress', 'testing', 'planning', 'review']),
    [],
  );
  const { meetingSeatById, meetingActive, meetingCount } = useMemo(() => {
    const activeSpecialists: string[] = [];
    for (const a of dynamicAgents) {
      if (a.id === 'main' || a.id === 'jarvis') continue;
      const tasks = activeByAgent.get(a.id);
      if (!tasks) continue;
      let active = false;
      for (const st of tasks.values()) {
        if (ACTIVE_TASK_STATUSES.has(st)) {
          active = true;
          break;
        }
      }
      if (active) activeSpecialists.push(a.id);
    }

    const map = new Map<string, [number, number, number]>();
    if (activeSpecialists.length < MEETING_MIN_PARTICIPANTS) {
      return { meetingSeatById: map, meetingActive: false, meetingCount: 0 };
    }

    // Head seat (index 0) for the orchestrator if it exists on the roster.
    const mainId = dynamicAgents.find((a) => a.id === 'main' || a.id === 'jarvis')?.id;
    let seatIdx = 0;
    if (mainId) {
      map.set(mainId, MEETING_SEATS[0]);
      seatIdx = 1;
    }
    for (const id of activeSpecialists) {
      if (seatIdx >= MEETING_SEATS.length) break; // table full — extras stay at desks
      map.set(id, MEETING_SEATS[seatIdx]);
      seatIdx += 1;
    }
    return { meetingSeatById: map, meetingActive: true, meetingCount: map.size };
  }, [dynamicAgents, activeByAgent, ACTIVE_TASK_STATUSES]);

  const handleDeskClick = (agentId: string) => {
    setSelectedAgent(agentId);
  };

  const handleClosePanel = () => {
    setSelectedAgent(null);
  };

  const handleFileCabinetClick = () => {
    setInteractionModal('memory');
  };

  const handleWhiteboardClick = () => {
    setInteractionModal('roadmap');
  };

  const handleCoffeeClick = () => {
    setInteractionModal('energy');
  };

  const handleCloseModal = () => {
    setInteractionModal(null);
  };

  const handleAvatarPositionUpdate = (id: string, position: any) => {
    setAvatarPositions(prev => new Map(prev).set(id, position));
  };

  // Definir obstáculos (muebles)
  const obstacles = [
    // Escritorios
    ...dynamicAgents.map(agent => ({
      position: new Vector3(agent.position[0], 0, agent.position[2]),
      radius: 1.5
    })),
    // Archivador
    { position: new Vector3(-8, 0, -5), radius: 0.8 },
    // Pizarra
    { position: new Vector3(0, 0, -8), radius: 1.5 },
    // Máquina de café
    { position: new Vector3(8, 0, -5), radius: 0.6 },
    // Plantas
    { position: new Vector3(-7, 0, 6), radius: 0.5 },
    { position: new Vector3(7, 0, 6), radius: 0.5 },
    { position: new Vector3(-9, 0, 0), radius: 0.4 },
    { position: new Vector3(9, 0, 0), radius: 0.4 },
    // Mesa de reunião — wanderers desviam; participantes sentados ignoram
    // este obstáculo (vão direto ao assento via meetingSeat).
    { position: new Vector3(MEETING_TABLE_CENTER[0], 0, MEETING_TABLE_CENTER[2]), radius: 2.2 },
  ];

  return (
    <div className="fixed inset-0 bg-gray-900" style={{ height: '100vh', width: '100vw' }}>
      <Canvas
        camera={{ position: [0, 8, 12], fov: 60 }}
        shadows={{ type: PCFShadowMap }}
        gl={{ antialias: true, alpha: false }}
        style={{ width: '100%', height: '100%' }}
      >
        <Suspense fallback={
          <mesh>
            <boxGeometry args={[2, 2, 2]} />
            <meshStandardMaterial color="orange" />
          </mesh>
        }>
          {/* Iluminación */}
          <Lights />

          {/* Cielo y ambiente */}
          <Sky sunPosition={[10, 2, 10]} />
          <Environment preset="sunset" />

          {/* Suelo */}
          <Floor />

          {/* Paredes */}
          <Walls />

          {/* Escritorios de agentes (sin avatares) */}
          {dynamicAgents.map((agent) => (
            <AgentDesk
              key={agent.id}
              agent={agent}
              state={agentStates[agent.id]}
              onClick={() => handleDeskClick(agent.id)}
              isSelected={selectedAgent === agent.id}
            />
          ))}

          {/* Mesa de reunião (sempre presente; acende quando há reunião) */}
          <MeetingTable active={meetingActive} attendees={meetingCount} />

          {/* Avatares móviles */}
          {dynamicAgents.map((agent) => (
            <MovingAvatar
              key={`avatar-${agent.id}`}
              agent={agent}
              state={agentStates[agent.id]}
              officeBounds={{ minX: -8, maxX: 8, minZ: -7, maxZ: 7 }}
              obstacles={obstacles}
              otherAvatarPositions={avatarPositions}
              deskPositions={deskPositions}
              meetingSeat={meetingSeatById.get(agent.id) ?? null}
              onPositionUpdate={handleAvatarPositionUpdate}
            />
          ))}

          {/* Mobiliario interactivo */}
          <FileCabinet
            position={[-8, 0, -5]}
            onClick={handleFileCabinetClick}
          />
          <Whiteboard
            position={[0, 0, -8]}
            rotation={[0, 0, 0]}
            onClick={handleWhiteboardClick}
          />
          <CoffeeMachine
            position={[8, 0.8, -5]}
            onClick={handleCoffeeClick}
          />

          {/* Decoración */}
          <PlantPot position={[-7, 0, 6]} size="large" />
          <PlantPot position={[7, 0, 6]} size="medium" />
          <PlantPot position={[-9, 0, 0]} size="small" />
          <PlantPot position={[9, 0, 0]} size="small" />
          <WallClock
            position={[0, 2.5, -8.4]}
            rotation={[0, 0, 0]}
          />

          {/* Controles de cámara */}
          {controlMode === 'orbit' ? (
            <OrbitControls
              enableDamping
              dampingFactor={0.05}
              minDistance={5}
              maxDistance={30}
              maxPolarAngle={Math.PI / 2.2}
            />
          ) : (
            <FirstPersonControls moveSpeed={5} />
          )}
        </Suspense>
      </Canvas>

      {/* Panel lateral cuando se selecciona un agente */}
      {selectedAgent && (
        <AgentPanel
          agent={dynamicAgents.find(a => a.id === selectedAgent)!}
          state={agentStates[selectedAgent]}
          onClose={handleClosePanel}
        />
      )}

      {/* Modal de interacciones con objetos */}
      {interactionModal && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-yellow-500 rounded-lg p-8 max-w-2xl w-full mx-4 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-yellow-400">
                {interactionModal === 'memory' && '📁 Memory Browser'}
                {interactionModal === 'roadmap' && '📋 Roadmap & Planning'}
                {interactionModal === 'energy' && '☕ Agent Energy Dashboard'}
              </h2>
              <button
                onClick={handleCloseModal}
                className="text-gray-400 hover:text-white text-3xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="text-gray-300 space-y-4">
              {interactionModal === 'memory' && (
                <>
                  <p className="text-lg">🧠 Access to workspace memories and files</p>
                  <div className="bg-gray-800 p-4 rounded border border-gray-700">
                    <p className="text-sm text-gray-400 mb-2">Quick links:</p>
                    <ul className="space-y-2">
                      <li><a href="/memory" className="text-yellow-400 hover:underline">→ Full Memory Browser</a></li>
                      <li><a href="/files" className="text-yellow-400 hover:underline">→ File Explorer</a></li>
                    </ul>
                  </div>
                  <p className="text-sm text-gray-500 italic">
                    This would show a file tree of memory/*.md and workspace files
                  </p>
                </>
              )}

              {interactionModal === 'roadmap' && (
                <>
                  <p className="text-lg">🗺️ Project roadmap and planning board</p>
                  <div className="bg-gray-800 p-4 rounded border border-gray-700">
                    <p className="text-sm text-gray-400 mb-2">Active phases:</p>
                    <ul className="space-y-2">
                      <li className="flex items-center gap-2">
                        <span className="text-green-400">✓</span>
                        <span>Phase 0: AtlasDeck Shell</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="text-yellow-400">●</span>
                        <span>Phase 8: The Office 3D (MVP)</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="text-gray-500">○</span>
                        <span>Phase 2: File Browser Pro</span>
                      </li>
                    </ul>
                  </div>
                  <p className="text-sm text-gray-500 italic">
                    Full roadmap available at workspace/mission-control/ROADMAP.md
                  </p>
                </>
              )}

              {interactionModal === 'energy' && (
                <>
                  <p className="text-lg">⚡ Agent activity and energy levels</p>
                  <div className="bg-gray-800 p-4 rounded border border-gray-700 space-y-3">
                    <div>
                      <p className="text-sm text-gray-400">Tokens consumed today:</p>
                      <p className="text-2xl font-bold text-yellow-400">47,000</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Active agents:</p>
                      <p className="text-2xl font-bold text-green-400">3 / 6</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">System uptime:</p>
                      <p className="text-2xl font-bold text-blue-400">12h 34m</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 italic">
                    This would show real-time agent mood/productivity metrics
                  </p>
                </>
              )}
            </div>

            <button
              onClick={handleCloseModal}
              className="mt-6 w-full bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-3 rounded transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Controles UI overlay */}
      <div className="absolute top-4 left-4 bg-black/70 text-white p-4 rounded-lg backdrop-blur-sm">
        <h2 className="text-lg font-bold mb-2">🏢 The Office</h2>
        <div className="text-sm space-y-1 mb-3">
          <p><strong>Mode: {controlMode === 'orbit' ? '🖱️ Orbit' : '🎮 FPS'}</strong></p>
          {controlMode === 'orbit' ? (
            <>
              <p>🖱️ Mouse: Rotar vista</p>
              <p>🔄 Scroll: Zoom</p>
              <p>👆 Click: Seleccionar</p>
            </>
          ) : (
            <>
              <p>Click to lock cursor</p>
              <p>WASD/Arrows: Mover</p>
              <p>Space: Subir | Shift: Bajar</p>
              <p>Mouse: Mirar | ESC: Unlock</p>
            </>
          )}
        </div>
        <button
          onClick={() => setControlMode(controlMode === 'orbit' ? 'fps' : 'orbit')}
          className="w-full bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-2 px-3 rounded text-xs transition-colors"
        >
          Switch to {controlMode === 'orbit' ? 'FPS Mode' : 'Orbit Mode'}
        </button>
      </div>

      {/* Legend — 7 estados de orquestração + foco do Jarvis */}
      <div className="absolute bottom-4 right-4 bg-black/70 text-white p-4 rounded-lg backdrop-blur-sm">
        <h3 className="text-sm font-bold mb-2">Estados</h3>
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
            <span>Idle (wandering)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
            <span>Thinking</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-full"></div>
            <span>Working</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-purple-500 rounded-full"></div>
            <span>Delegating (Jarvis)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-orange-500 rounded-full animate-pulse"></div>
            <span>Reviewing (Jarvis)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
            <span>Stuck</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-zinc-700 rounded-full"></div>
            <span>Offline</span>
          </div>
        </div>
      </div>
    </div>
  );
}
