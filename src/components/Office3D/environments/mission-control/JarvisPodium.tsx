'use client';

/**
 * Raised command platform at the back of the room where the orchestrator
 * (Jarvis) oversees the floor: platform, command desk with a triple
 * status display, and a chair facing the videowall.
 */
import { useState } from 'react';
import { Box, Text } from '@react-three/drei';
import type { AgentState } from '../../agentsConfig';
import type { OfficeAgent } from '../../shared/data/useOfficeData';
import { STATUS_COLOR } from '../../shared/statusColors';
import ScreenSurface from '../../shared/screens/ScreenSurface';
import VoxelChair from '../../VoxelChair';
import { PODIUM } from './layout';

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

interface JarvisPodiumProps {
  agent: OfficeAgent | null;
  state?: AgentState;
  onClick: () => void;
  isSelected: boolean;
}

export default function JarvisPodium({ agent, state, onClick, isSelected }: JarvisPodiumProps) {
  const [hovered, setHovered] = useState(false);
  const s = state ?? IDLE_STATE;
  const statusColor = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;
  const [px, , pz] = PODIUM.center;
  const [pw, ph, pd] = PODIUM.size;

  return (
    <group position={[px, 0, pz]}>
      {/* Platform */}
      <Box
        args={[pw, ph, pd]}
        position={[0, ph / 2, 0]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={hovered || isSelected ? '#1f2c44' : '#16213a'}
          metalness={0.3}
          roughness={0.6}
        />
      </Box>
      {/* Platform edge glow — four thin strips, not a slab */}
      {[
        { args: [pw + 0.06, 0.05, 0.08] as [number, number, number], pos: [0, ph, pd / 2] as [number, number, number] },
        { args: [pw + 0.06, 0.05, 0.08] as [number, number, number], pos: [0, ph, -pd / 2] as [number, number, number] },
        { args: [0.08, 0.05, pd + 0.06] as [number, number, number], pos: [pw / 2, ph, 0] as [number, number, number] },
        { args: [0.08, 0.05, pd + 0.06] as [number, number, number], pos: [-pw / 2, ph, 0] as [number, number, number] },
      ].map((strip, i) => (
        <Box key={i} args={strip.args} position={strip.pos}>
          <meshStandardMaterial
            color={statusColor}
            emissive={statusColor}
            emissiveIntensity={0.7}
            toneMapped={false}
          />
        </Box>
      ))}
      {/* Front step */}
      <Box args={[1.6, ph / 2, 0.8]} position={[0, ph / 4, pd / 2 + 0.4]} castShadow receiveShadow>
        <meshStandardMaterial color="#101a30" metalness={0.3} roughness={0.7} />
      </Box>

      {/* Command desk on the platform, facing the videowall (-z) */}
      <group position={[0, ph, -0.55]}>
        <Box args={[2.4, 0.07, 0.8]} position={[0, 0.76, 0]} castShadow onClick={onClick}>
          <meshStandardMaterial color="#1e293b" metalness={0.4} roughness={0.5} />
        </Box>
        <Box args={[2.4, 0.72, 0.07]} position={[0, 0.38, -0.36]} castShadow>
          <meshStandardMaterial color="#0f172a" />
        </Box>
        {/* Triple display */}
        {[-0.82, 0, 0.82].map((x, i) => (
          <group key={x} position={[x, 1.28, -0.28]} rotation={[-0.1, x * -0.18, 0]}>
            <Box args={[0.82, 0.6, 0.05]} castShadow>
              <meshStandardMaterial color="#0b1220" metalness={0.5} roughness={0.4} />
            </Box>
            <ScreenSurface
              size={[0.74, 0.52]}
              program={i === 1 ? 'kanbanColumns' : i === 0 ? 'graphWave' : 'codeScroll'}
              color={statusColor}
              position={[0, 0, 0.03]}
            />
          </group>
        ))}
        {/* Chair — base on the platform top (this group already sits at y=ph) */}
        <group scale={2}>
          <VoxelChair position={[0, 0, 0.5]} rotation={[0, Math.PI, 0]} color="#27272a" />
        </group>
      </group>

      {/* Nameplate */}
      <Text
        position={[0, ph + 2.4, -0.4]}
        fontSize={0.2}
        color="#facc15"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.012}
        outlineColor="#000000"
      >
        {agent ? `${agent.emoji} ${agent.name}` : '🤖 Orquestrador'}
      </Text>
      <Text position={[0, ph + 2.12, -0.4]} fontSize={0.11} color={statusColor} anchorX="center" anchorY="middle">
        {s.status.toUpperCase()}
      </Text>

      {isSelected && (
        <mesh position={[0, ph + 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.6, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.25} />
        </mesh>
      )}
    </group>
  );
}
