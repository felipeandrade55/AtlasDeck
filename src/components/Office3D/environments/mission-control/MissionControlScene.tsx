'use client';

/**
 * Mission Control HQ — NASA-style control room. Composition only: all
 * spatial data comes from layout.ts, all agent data from props (the shell
 * owns the single useOfficeData instance).
 */
import { useEffect, useMemo } from 'react';
import { Box } from '@react-three/drei';
import { CanvasTexture, RepeatWrapping } from 'three';
import type { Task } from '@/components/LiveMission/types';
import type { OfficeData } from '../../shared/data/useOfficeData';
import type { OfficeBus } from '../../shared/data/OfficeDataProvider';
import { useOfficeStore } from '../../shared/data/officeStore';
import AgentActor from '../../shared/behavior/AgentActor';
import CoffeeMachine from '../../CoffeeMachine';
import PlantPot from '../../PlantPot';
import WallClock from '../../WallClock';
import { MEETING_MIN_PARTICIPANTS } from '../../meetingConfig';
import { buildMissionControlLayout, ROOM, VIDEOWALL, WAR_SEATS } from './layout';
import Console from './Console';
import JarvisPodium from './JarvisPodium';
import WarRoomGlass from './WarRoomGlass';
import Videowall from './Videowall';
import Lounge from './Lounge';

interface MissionControlSceneProps {
  data: OfficeData;
  /** Live task list + event bus, passed as props because React context
   *  does not cross the R3F Canvas boundary. */
  tasks: Task[];
  bus: OfficeBus;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
}

export default function MissionControlScene({ data, tasks, bus, selectedAgentId, onSelectAgent }: MissionControlSceneProps) {
  const { agents, agentStates, meetingParticipantIds, mainAgentId } = data;

  const { layout, consoles } = useMemo(() => buildMissionControlLayout(agents), [agents]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mainAgent = mainAgentId ? agentById.get(mainAgentId) ?? null : null;

  // Seat assignment: head seat for the orchestrator, then specialists.
  const meetingSeatIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (meetingParticipantIds.length < MEETING_MIN_PARTICIPANTS) return m;
    let idx = 0;
    if (mainAgentId) m.set(mainAgentId, idx++);
    for (const id of meetingParticipantIds) {
      if (idx >= WAR_SEATS.length) break;
      m.set(id, idx++);
    }
    return m;
  }, [meetingParticipantIds, mainAgentId]);
  const meetingActive = meetingSeatIndexById.size > 0;

  // Clear transient cross-avatar state when this environment unmounts.
  useEffect(() => {
    return () => useOfficeStore.getState().resetTransient();
  }, []);

  return (
    <group>
      <ControlRoomLights />
      <ControlRoomShell />

      <Videowall data={data} tasks={tasks} bus={bus} />

      {/* Specialist consoles */}
      {consoles.map((slot) => {
        const agent = agentById.get(slot.agentId);
        if (!agent) return null;
        return (
          <Console
            key={slot.agentId}
            agent={agent}
            state={agentStates[slot.agentId]}
            position={slot.position}
            onClick={() => onSelectAgent(slot.agentId)}
            isSelected={selectedAgentId === slot.agentId}
          />
        );
      })}

      {/* Orchestrator podium */}
      <JarvisPodium
        agent={mainAgent}
        state={mainAgentId ? agentStates[mainAgentId] : undefined}
        onClick={() => mainAgentId && onSelectAgent(mainAgentId)}
        isSelected={selectedAgentId !== null && selectedAgentId === mainAgentId}
      />

      <WarRoomGlass active={meetingActive} attendees={meetingSeatIndexById.size} />
      <Lounge />

      {/* Walking avatars */}
      {agents.map((agent) => (
        <AgentActor
          key={`actor-${agent.id}`}
          agent={agent}
          state={agentStates[agent.id]}
          layout={layout}
          meetingSeatIndex={meetingSeatIndexById.get(agent.id) ?? null}
        />
      ))}

      {/* Decoration / POI furniture */}
      <group rotation={[0, -Math.PI / 2, 0]} position={[11.8, 0.8, 5.2]}>
        <CoffeeMachine position={[0, 0, 0]} />
      </group>
      <PlantPot position={[-12.2, 0, -8.2]} size="large" />
      <PlantPot position={[12.2, 0, -8.2]} size="large" />
      <WallClock position={[VIDEOWALL.width / 2 + 3.5, 4.6, -ROOM.depth / 2 + 0.15]} rotation={[0, 0, 0]} />
    </group>
  );
}

/** Dark control-room lighting: cool ambient + one shadow light. */
function ControlRoomLights() {
  return (
    <>
      <color attach="background" args={['#070b14']} />
      <fog attach="fog" args={['#070b14', 28, 55]} />
      <ambientLight intensity={0.65} color="#aab8d8" />
      <directionalLight
        position={[6, 12, 8]}
        intensity={0.7}
        color="#dbe6ff"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={60}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
      />
      {/* Videowall glow spilling onto the floor */}
      <pointLight position={[0, 3.5, -7]} intensity={18} distance={14} color="#3b82f6" />
      <hemisphereLight args={['#1e293b', '#0b1020', 0.5]} />
    </>
  );
}

/** Floor + walls of the control room. */
function ControlRoomShell() {
  const floorTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#10182b';
    ctx.fillRect(0, 0, 256, 256);
    // Subtle tile grid
    ctx.strokeStyle = 'rgba(56,77,128,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 256);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(256, i);
      ctx.stroke();
    }
    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(ROOM.width / 4, ROOM.depth / 4);
    return texture;
  }, []);

  const { width, depth, height } = ROOM;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={floorTexture} roughness={0.85} metalness={0.1} />
      </mesh>
      {/* back wall only (+ sides) — no front wall, the orbit camera looks
          in from there exactly like the classic scene */}
      <Box args={[width, height, 0.25]} position={[0, height / 2, -depth / 2]} receiveShadow>
        <meshStandardMaterial color="#0c1322" roughness={0.9} />
      </Box>
      {/* sides */}
      <Box args={[0.25, height, depth]} position={[-width / 2, height / 2, 0]} receiveShadow>
        <meshStandardMaterial color="#0e1526" roughness={0.9} />
      </Box>
      <Box args={[0.25, height, depth]} position={[width / 2, height / 2, 0]} receiveShadow>
        <meshStandardMaterial color="#0e1526" roughness={0.9} />
      </Box>
    </group>
  );
}
