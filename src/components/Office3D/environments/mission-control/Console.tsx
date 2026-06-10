'use client';

/**
 * One specialist console: angled desk facing the videowall, monitor with a
 * stylized code-scroll screen tinted by agent status, chair and nameplate.
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
import AlarmBeacon from './AlarmBeacon';

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

interface ConsoleProps {
  agent: OfficeAgent;
  state?: AgentState;
  position: [number, number, number];
  onClick: () => void;
  isSelected: boolean;
}

export default function Console({ agent, state, position, onClick, isSelected }: ConsoleProps) {
  const [hovered, setHovered] = useState(false);
  const s = state ?? IDLE_STATE;
  const statusColor = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;
  const screenProgram = s.status === 'offline' ? 'off' : 'codeScroll';

  return (
    <group position={position}>
      {/* Desk top */}
      <Box
        args={[2.1, 0.08, 1.0]}
        position={[0, 0.78, 0]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={hovered || isSelected ? '#334155' : '#1e293b'}
          emissive={hovered || isSelected ? agent.color : '#000000'}
          emissiveIntensity={hovered || isSelected ? 0.25 : 0}
          metalness={0.4}
          roughness={0.5}
        />
      </Box>
      {/* Front panel (closed console look) */}
      <Box args={[2.1, 0.74, 0.08]} position={[0, 0.37, -0.46]} castShadow>
        <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.7} />
      </Box>
      {/* Side legs */}
      {[-0.95, 0.95].map((x) => (
        <Box key={x} args={[0.08, 0.74, 0.9]} position={[x, 0.37, 0]} castShadow>
          <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.7} />
        </Box>
      ))}

      {/* Monitor frame, slightly tilted toward the seated agent */}
      <group position={[0, 1.32, -0.32]} rotation={[-0.12, 0, 0]}>
        <Box args={[1.5, 0.92, 0.06]} castShadow onClick={onClick}>
          <meshStandardMaterial color="#0b1220" metalness={0.5} roughness={0.4} />
        </Box>
        <ScreenSurface
          size={[1.38, 0.8]}
          program={screenProgram}
          color={statusColor}
          position={[0, 0, 0.035]}
        />
      </group>
      {/* Monitor arm */}
      <Box args={[0.08, 0.5, 0.08]} position={[0, 0.95, -0.38]} castShadow>
        <meshStandardMaterial color="#1e293b" />
      </Box>

      {/* Status strip on the desk edge */}
      <Box args={[2.1, 0.04, 0.04]} position={[0, 0.83, 0.5]}>
        <meshStandardMaterial
          color={statusColor}
          emissive={statusColor}
          emissiveIntensity={s.status === 'offline' ? 0.1 : 0.9}
          toneMapped={false}
        />
      </Box>

      {/* Chair (faces the videowall: backrest toward +z) */}
      <group scale={2}>
        <VoxelChair position={[0, 0, 0.55]} rotation={[0, Math.PI, 0]} color="#1f2937" />
      </group>

      {/* Nameplate + status — billboarded so it always faces the camera */}
      <Billboard position={[0, 2.28, -0.2]}>
        <Text
          fontSize={0.16}
          color="white"
          anchorX="center"
          anchorY="middle"
          maxWidth={2.4}
          outlineWidth={0.01}
          outlineColor="#000000"
        >
          {agent.emoji} {shortName(agent.name)}
        </Text>
        <Text position={[0, -0.24, 0]} fontSize={0.1} color={statusColor} anchorX="center" anchorY="middle">
          {s.status.toUpperCase()}
        </Text>
      </Billboard>

      {/* Emergency beacon when stuck */}
      {s.status === 'stuck' && <AlarmBeacon position={[0.85, 0.82, -0.25]} />}

      {/* Floor glow when selected */}
      {isSelected && (
        <mesh position={[0, 0.01, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.4, 32]} />
          <meshBasicMaterial color={agent.color} transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}
