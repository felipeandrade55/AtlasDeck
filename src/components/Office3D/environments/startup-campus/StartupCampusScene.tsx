'use client';

/**
 * Startup Campus — the task pipeline as physical space. New missions
 * arrive as envelopes at reception; owners walk over, pick them up and
 * carry them to their notebook desk; review piles up on the QA desk;
 * approved deliveries hang on the Done wall; idle agents hit the lounge.
 */
import { useEffect, useMemo } from 'react';
import { Box, Text } from '@react-three/drei';
import { CanvasTexture, RepeatWrapping } from 'three';
import type { Task } from '@/components/LiveMission/types';
import type { OfficeData } from '../../shared/data/useOfficeData';
import type { OfficeBus } from '../../shared/data/OfficeDataProvider';
import { useOfficeStore } from '../../shared/data/officeStore';
import AgentActor from '../../shared/behavior/AgentActor';
import PlantPot from '../../PlantPot';
import WallClock from '../../WallClock';
import { MEETING_MIN_PARTICIPANTS } from '../../meetingConfig';
import { buildStartupCampusLayout, ROOM } from './layout';
import Reception from './Reception';
import OpenSpaceDesk from './OpenSpaceDesk';
import QaDesk from './QaDesk';
import DoneWall from './DoneWall';
import CampusLounge from './CampusLounge';
import WarZone from './WarZone';
import Envelopes from './envelopes/Envelopes';
import { useEnvelopes } from './envelopes/useEnvelopes';

interface StartupCampusSceneProps {
  data: OfficeData;
  tasks: Task[];
  bus: OfficeBus;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
}

export default function StartupCampusScene({
  data,
  tasks,
  bus,
  selectedAgentId,
  onSelectAgent,
}: StartupCampusSceneProps) {
  const { agents, agentStates, meetingParticipantIds, mainAgentId } = data;

  const { layout, desks } = useMemo(() => buildStartupCampusLayout(agents), [agents]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentColors = useMemo(() => new Map(agents.map((a) => [a.id, a.color])), [agents]);
  const mainAgent = mainAgentId ? agentById.get(mainAgentId) ?? null : null;

  const envelopes = useEnvelopes(tasks, layout, bus);
  const inboxCount = useMemo(
    () => Array.from(envelopes.values()).filter((e) => e.phase === 'inbox').length,
    [envelopes],
  );
  const reviewCount = useMemo(
    () => Array.from(envelopes.values()).filter((e) => e.phase === 'in-review').length,
    [envelopes],
  );

  const meetingSeatIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (meetingParticipantIds.length < MEETING_MIN_PARTICIPANTS) return m;
    let idx = 0;
    if (mainAgentId) m.set(mainAgentId, idx++);
    for (const id of meetingParticipantIds) {
      if (idx >= 6) break;
      m.set(id, idx++);
    }
    return m;
  }, [meetingParticipantIds, mainAgentId]);
  const meetingActive = meetingSeatIndexById.size > 0;

  useEffect(() => {
    return () => useOfficeStore.getState().resetTransient();
  }, []);

  return (
    <group>
      <CampusLights />
      <CampusShell />

      <Reception inboxCount={inboxCount} />

      {desks.map((slot) => {
        const agent = agentById.get(slot.agentId);
        if (!agent) return null;
        return (
          <OpenSpaceDesk
            key={slot.agentId}
            agent={agent}
            state={agentStates[slot.agentId]}
            position={slot.position}
            onClick={() => onSelectAgent(slot.agentId)}
            isSelected={selectedAgentId === slot.agentId}
          />
        );
      })}

      <QaDesk
        agent={mainAgent}
        state={mainAgentId ? agentStates[mainAgentId] : undefined}
        reviewCount={reviewCount}
        onClick={() => mainAgentId && onSelectAgent(mainAgentId)}
        isSelected={selectedAgentId !== null && selectedAgentId === mainAgentId}
      />

      <WarZone active={meetingActive} attendees={meetingSeatIndexById.size} />
      <DoneWall tasks={tasks} />
      <CampusLounge />

      <Envelopes envelopes={envelopes} desks={desks} agentColors={agentColors} />

      {agents.map((agent) => (
        <AgentActor
          key={`actor-${agent.id}`}
          agent={agent}
          state={agentStates[agent.id]}
          layout={layout}
          meetingSeatIndex={meetingSeatIndexById.get(agent.id) ?? null}
        />
      ))}

      {/* Decoration */}
      <PlantPot position={[-12.2, 0, 8.2]} size="large" />
      <PlantPot position={[-12.2, 0, -8.6]} size="medium" />
      <WallClock position={[8.5, 4.2, -ROOM.depth / 2 + 0.15]} rotation={[0, 0, 0]} />
    </group>
  );
}

/** Bright, warm startup lighting. */
function CampusLights() {
  return (
    <>
      <color attach="background" args={['#171c26']} />
      <fog attach="fog" args={['#171c26', 30, 60]} />
      <ambientLight intensity={0.65} color="#fff7ed" />
      <directionalLight
        position={[-8, 12, 6]}
        intensity={0.9}
        color="#ffedd5"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={60}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
      />
      <hemisphereLight args={['#bfdbfe', '#3f3f46', 0.45]} />
    </>
  );
}

/** Wooden floor + light walls with windows on the left wall. */
function CampusShell() {
  const floorTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#9c7b50';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 256; i += 10) {
      const shade = Math.sin(i * 0.15) * 14;
      ctx.fillStyle = `rgb(${156 + shade}, ${123 + shade}, ${80 + shade})`;
      ctx.fillRect(i, 0, 4, 256);
    }
    // Plank seams
    ctx.strokeStyle = 'rgba(70,50,30,0.5)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= 256; y += 52) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }
    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(ROOM.width / 5, ROOM.depth / 5);
    return texture;
  }, []);

  const { width, depth, height } = ROOM;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={floorTexture} roughness={0.85} />
      </mesh>
      {/* back wall only — no front wall so the orbit camera looks straight
          into the campus (the conveyor still reads as "along the entrance") */}
      <Box args={[width, height, 0.25]} position={[0, height / 2, -depth / 2]} receiveShadow>
        <meshStandardMaterial color="#2a3242" roughness={0.9} />
      </Box>
      {/* side walls */}
      <Box args={[0.25, height, depth]} position={[-width / 2, height / 2, 0]} receiveShadow>
        <meshStandardMaterial color="#313a4d" roughness={0.9} />
      </Box>
      <Box args={[0.25, height, depth]} position={[width / 2, height / 2, 0]} receiveShadow>
        <meshStandardMaterial color="#313a4d" roughness={0.9} />
      </Box>
      {/* "Windows" on the left wall — emissive sky panes */}
      {[-6, -1, 4].map((z) => (
        <Box key={z} args={[0.1, 2.2, 3.2]} position={[-width / 2 + 0.1, 3.4, z]}>
          <meshStandardMaterial color="#7dd3fc" emissive="#7dd3fc" emissiveIntensity={0.35} toneMapped={false} />
        </Box>
      ))}
      {/* Logo high on the back wall */}
      <Text position={[-2.5, 5.6, -depth / 2 + 0.2]} fontSize={0.55} color="#facc15" anchorX="center" anchorY="middle" outlineWidth={0.02} outlineColor="#000000">
        ⚡ ATLAS CAMPUS
      </Text>
    </group>
  );
}
