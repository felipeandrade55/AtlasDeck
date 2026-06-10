'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sky, Environment } from '@react-three/drei';
import { Suspense, useState, useMemo } from 'react';
import { Vector3, PCFShadowMap } from 'three';
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
import OfficeDataProvider from './shared/data/OfficeDataProvider';
import { useOfficeData } from './shared/data/useOfficeData';

/** Classic-scene desk positions, assigned by roster order (main = center). */
const PRESET_POSITIONS: [number, number, number][] = [
  [0, 0, 0],
  [-4, 0, -3],
  [4, 0, -3],
  [-4, 0, 3],
  [4, 0, 3],
  [0, 0, 6],
];

export default function Office3D() {
  return (
    <OfficeDataProvider>
      <Office3DScene />
    </OfficeDataProvider>
  );
}

function Office3DScene() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [interactionModal, setInteractionModal] = useState<string | null>(null);
  const [controlMode, setControlMode] = useState<'orbit' | 'fps'>('orbit');

  const { agents, agentStates, meetingParticipantIds, mainAgentId } = useOfficeData();

  /** Roster + classic preset positions (main pinned to the center desk). */
  const dynamicAgents = useMemo(
    () =>
      agents.map((agent, idx) => {
        let posIndex = idx;
        if (agent.id === 'main') posIndex = 0;
        else if (idx === 0) posIndex = 1;
        const position = PRESET_POSITIONS[posIndex % PRESET_POSITIONS.length] || [
          Math.sin(idx * 2) * 6,
          0,
          Math.cos(idx * 2) * 6,
        ];
        return { ...agent, position: position as [number, number, number] };
      }),
    [agents],
  );

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
  const { meetingSeatById, meetingActive, meetingCount } = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    if (meetingParticipantIds.length < MEETING_MIN_PARTICIPANTS) {
      return { meetingSeatById: map, meetingActive: false, meetingCount: 0 };
    }

    // Head seat (index 0) for the orchestrator if it exists on the roster.
    let seatIdx = 0;
    if (mainAgentId) {
      map.set(mainAgentId, MEETING_SEATS[0]);
      seatIdx = 1;
    }
    for (const id of meetingParticipantIds) {
      if (seatIdx >= MEETING_SEATS.length) break; // table full — extras stay at desks
      map.set(id, MEETING_SEATS[seatIdx]);
      seatIdx += 1;
    }
    return { meetingSeatById: map, meetingActive: true, meetingCount: map.size };
  }, [meetingParticipantIds, mainAgentId]);

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
              deskPositions={deskPositions}
              meetingSeat={meetingSeatById.get(agent.id) ?? null}
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
