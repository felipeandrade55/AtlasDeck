'use client';

/**
 * Open-space desk with a NOTEBOOK (lid + screen) instead of the classic
 * external monitor. The lid screen runs the stylized code program tinted
 * by the agent's live status.
 */
import { useState } from 'react';
import { Billboard, Box, Text } from '@react-three/drei';

function shortName(name: string, max = 18): string {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}
import type { AgentState } from '../../agentsConfig';
import type { OfficeAgent } from '../../shared/data/useOfficeData';
import { STATUS_COLOR } from '../../shared/statusColors';
import ScreenSurface from '../../shared/screens/ScreenSurface';
import VoxelChair from '../../VoxelChair';

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

interface OpenSpaceDeskProps {
  agent: OfficeAgent;
  state?: AgentState;
  position: [number, number, number];
  onClick: () => void;
  isSelected: boolean;
}

export default function OpenSpaceDesk({ agent, state, position, onClick, isSelected }: OpenSpaceDeskProps) {
  const [hovered, setHovered] = useState(false);
  const s = state ?? IDLE_STATE;
  const statusColor = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;

  return (
    <group position={position}>
      {/* Desk top (light wood) */}
      <Box
        args={[2.0, 0.08, 1.0]}
        position={[0, 0.78, 0]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={hovered || isSelected ? '#d4b483' : '#c8a36a'}
          emissive={hovered || isSelected ? agent.color : '#000000'}
          emissiveIntensity={hovered || isSelected ? 0.18 : 0}
          roughness={0.8}
        />
      </Box>
      {/* Legs */}
      {[-0.9, 0.9].map((x) =>
        [-0.4, 0.4].map((z) => (
          <Box key={`${x}${z}`} args={[0.07, 0.74, 0.07]} position={[x, 0.37, z]} castShadow>
            <meshStandardMaterial color="#7c5c36" />
          </Box>
        )),
      )}

      {/* Notebook: base + tilted lid with screen facing the agent (+z) */}
      <group position={[0, 0.83, 0.05]} onClick={onClick}>
        <Box args={[0.62, 0.03, 0.42]} castShadow>
          <meshStandardMaterial color="#cbd5e1" metalness={0.6} roughness={0.35} />
        </Box>
        <group position={[0, 0.2, -0.2]} rotation={[0.32, 0, 0]}>
          <Box args={[0.62, 0.44, 0.025]}>
            <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} />
          </Box>
          <ScreenSurface
            size={[0.56, 0.38]}
            program={s.status === 'offline' ? 'off' : 'codeScroll'}
            color={statusColor}
            position={[0, 0, 0.016]}
            resolution={[96, 64]}
          />
        </group>
      </group>

      {/* Status LED strip on the desk edge */}
      <Box args={[2.0, 0.035, 0.035]} position={[0, 0.82, 0.5]}>
        <meshStandardMaterial
          color={statusColor}
          emissive={statusColor}
          emissiveIntensity={s.status === 'offline' ? 0.1 : 0.8}
          toneMapped={false}
        />
      </Box>

      {/* Chair behind the desk (+z), backrest toward +z */}
      <group scale={2}>
        <VoxelChair position={[0, 0, 0.55]} rotation={[0, Math.PI, 0]} color="#374151" />
      </group>

      {/* Nameplate + status — billboarded so it always faces the camera */}
      <Billboard position={[0, 2.05, 0]}>
        <Text
          fontSize={0.15}
          color="white"
          anchorX="center"
          anchorY="middle"
          maxWidth={2.4}
          outlineWidth={0.01}
          outlineColor="#000000"
        >
          {agent.emoji} {shortName(agent.name)}
        </Text>
        <Text position={[0, -0.22, 0]} fontSize={0.09} color={statusColor} anchorX="center" anchorY="middle">
          {s.status.toUpperCase()}
        </Text>
      </Billboard>

      {isSelected && (
        <mesh position={[0, 0.01, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.3, 32]} />
          <meshBasicMaterial color={agent.color} transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}
