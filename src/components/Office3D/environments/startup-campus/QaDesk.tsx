'use client';

/**
 * The orchestrator's QA desk: a bigger desk facing the room where review
 * envelopes pile up (the stack itself is rendered by <Envelopes>, this
 * component provides the furniture + the queue counter).
 */
import { useState } from 'react';
import { Box, Text } from '@react-three/drei';
import type { AgentState } from '../../agentsConfig';
import type { OfficeAgent } from '../../shared/data/useOfficeData';
import { STATUS_COLOR } from '../../shared/statusColors';
import ScreenSurface from '../../shared/screens/ScreenSurface';
import VoxelChair from '../../VoxelChair';
import { QA_DESK } from './layout';

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

interface QaDeskProps {
  agent: OfficeAgent | null;
  state?: AgentState;
  reviewCount: number;
  onClick: () => void;
  isSelected: boolean;
}

export default function QaDesk({ agent, state, reviewCount, onClick, isSelected }: QaDeskProps) {
  const [hovered, setHovered] = useState(false);
  const s = state ?? IDLE_STATE;
  const statusColor = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;
  const [cx, , cz] = QA_DESK.center;

  return (
    <group position={[cx, 0, cz]}>
      {/* Desk top — wide L-ish desk facing the room (+z) */}
      <Box
        args={[2.8, 0.09, 1.2]}
        position={[0, 0.8, 0]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={hovered || isSelected ? '#52525b' : '#3f3f46'}
          emissive={hovered || isSelected ? '#facc15' : '#000000'}
          emissiveIntensity={hovered || isSelected ? 0.15 : 0}
          roughness={0.6}
        />
      </Box>
      {/* Modesty panel toward the room */}
      <Box args={[2.8, 0.72, 0.08]} position={[0, 0.38, 0.55]} castShadow>
        <meshStandardMaterial color="#27272a" />
      </Box>
      {[-1.3, 1.3].map((x) => (
        <Box key={x} args={[0.08, 0.76, 1.1]} position={[x, 0.38, 0]} castShadow>
          <meshStandardMaterial color="#27272a" />
        </Box>
      ))}

      {/* Notebook for Jarvis (screen faces -z, where he sits) */}
      <group position={[-0.6, 0.86, 0]} rotation={[0, Math.PI, 0]}>
        <Box args={[0.62, 0.03, 0.42]} castShadow>
          <meshStandardMaterial color="#facc15" metalness={0.5} roughness={0.4} />
        </Box>
        <group position={[0, 0.2, -0.2]} rotation={[0.32, 0, 0]}>
          <Box args={[0.62, 0.44, 0.025]}>
            <meshStandardMaterial color="#ca8a04" metalness={0.5} roughness={0.4} />
          </Box>
          <ScreenSurface
            size={[0.56, 0.38]}
            program={s.status === 'offline' ? 'off' : 'kanbanColumns'}
            color={statusColor}
            position={[0, 0, 0.016]}
            resolution={[96, 64]}
          />
        </group>
      </group>

      {/* "REVISÃO" tray where the envelope stack lands */}
      <Box args={[0.6, 0.04, 0.42]} position={[QA_DESK.stackBase[0] - cx, 0.84, QA_DESK.stackBase[2] - cz]} castShadow>
        <meshStandardMaterial color="#1f2937" />
      </Box>

      {/* Chair behind the desk (-z), facing the room */}
      <group scale={2}>
        <VoxelChair position={[0, 0, -0.55]} rotation={[0, 0, 0]} color="#18181b" />
      </group>

      <Text
        position={[0, 2.3, 0]}
        fontSize={0.18}
        color="#facc15"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.012}
        outlineColor="#000000"
      >
        🛡️ QA — {agent ? agent.name : 'Orquestrador'}
      </Text>
      <Text position={[0, 2.06, 0]} fontSize={0.11} color={reviewCount > 0 ? '#f97316' : '#64748b'} anchorX="center" anchorY="middle">
        {reviewCount > 0 ? `${reviewCount} na fila de revisão` : 'fila de revisão vazia'}
      </Text>

      {isSelected && (
        <mesh position={[0, 0.01, -0.6]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.5, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.25} />
        </mesh>
      )}
    </group>
  );
}
