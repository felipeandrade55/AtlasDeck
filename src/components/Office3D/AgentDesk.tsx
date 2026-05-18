'use client';

import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Box } from '@react-three/drei';
import type { Mesh } from 'three';
import type { AgentConfig, AgentState } from './agentsConfig';
import VoxelChair from './VoxelChair';
import VoxelKeyboard from './VoxelKeyboard';
import VoxelMacMini from './VoxelMacMini';

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

const STATUS_COLOR: Record<string, string> = {
  working:  '#22c55e',
  thinking: '#3b82f6',
  error:    '#ef4444',
  idle:     '#6b7280',
};

const STATUS_EMISSIVE: Record<string, string> = {
  working:  '#15803d',
  thinking: '#1e40af',
  error:    '#991b1b',
  idle:     '#374151',
};

interface AgentDeskProps {
  agent: AgentConfig;
  state?: AgentState;
  onClick: () => void;
  isSelected: boolean;
}

export default function AgentDesk({ agent, state, onClick, isSelected }: AgentDeskProps) {
  const deskRef = useRef<Mesh>(null);
  const monitorRef = useRef<Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const s = state ?? IDLE_STATE;
  const statusColor    = STATUS_COLOR[s.status]    ?? STATUS_COLOR.idle;
  const monitorEmissive = STATUS_EMISSIVE[s.status] ?? STATUS_EMISSIVE.idle;

  useFrame((frameState) => {
    if (monitorRef.current && s.status === 'thinking') {
      monitorRef.current.scale.setScalar(1 + Math.sin(frameState.clock.elapsedTime * 2) * 0.05);
    }
  });

  return (
    <group position={agent.position}>
      {/* Desk surface */}
      <Box
        ref={deskRef}
        args={[2, 0.1, 1.5]}
        position={[0, 0.75, 0]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={hovered || isSelected ? agent.color : '#8B4513'}
          emissive={hovered || isSelected ? agent.color : '#000000'}
          emissiveIntensity={hovered || isSelected ? 0.2 : 0}
        />
      </Box>

      {/* Monitor */}
      <Box
        ref={monitorRef}
        args={[1.2, 0.8, 0.05]}
        position={[0, 1.5, -0.5]}
        castShadow
        onClick={onClick}
      >
        <meshStandardMaterial
          color={statusColor}
          emissive={monitorEmissive}
          emissiveIntensity={s.status === 'idle' ? 0.1 : 0.5}
        />
      </Box>

      {/* Monitor stand */}
      <Box args={[0.1, 0.4, 0.1]} position={[0, 1, -0.5]} castShadow>
        <meshStandardMaterial color="#2d2d2d" />
      </Box>

      {/* Keyboard */}
      <VoxelKeyboard position={[0, 0.81, 0.2]} rotation={[0, 0, 0]} />

      {/* Mac mini */}
      <VoxelMacMini position={[0.5, 0.825, -0.5]} />

      {/* Office Chair */}
      <group scale={2}>
        <VoxelChair position={[0, 0, 0.9]} rotation={[0, Math.PI, 0]} color="#1f2937" />
      </group>

      {/* Nameplate */}
      <Text
        position={[0, 2.5, 0]}
        fontSize={0.15}
        color="white"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.01}
        outlineColor="#000000"
      >
        {agent.emoji} {agent.name}
      </Text>

      {/* Status label */}
      <Text
        position={[0, 2.2, 0]}
        fontSize={0.1}
        color={statusColor}
        anchorX="center"
        anchorY="middle"
      >
        {s.status.toUpperCase()}
        {s.model ? ` • ${s.model}` : ''}
      </Text>

      {/* Desk legs */}
      {[-0.8, 0.8].map((x, i) =>
        [-0.6, 0.6].map((z, j) => (
          <Box
            key={`leg-${i}-${j}`}
            args={[0.05, 0.7, 0.05]}
            position={[x, 0.35, z]}
            castShadow
          >
            <meshStandardMaterial color="#5d4037" />
          </Box>
        ))
      )}

      {/* Floor glow when selected */}
      {isSelected && (
        <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.5, 32]} />
          <meshBasicMaterial color={agent.color} transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}
