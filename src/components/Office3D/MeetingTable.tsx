'use client';

import { useRef } from 'react';
import { Box, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import VoxelChair from './VoxelChair';
import {
  MEETING_TABLE_CENTER,
  MEETING_TABLE_SIZE,
  MEETING_SEATS,
  facingTableY,
} from './meetingConfig';

interface Props {
  /** True when a meeting is in progress — lights up the table + shows label. */
  active: boolean;
  /** How many seats are occupied right now (for the floating label). */
  attendees?: number;
}

/**
 * Meeting room: a rectangular table with chairs around it, placed in front
 * of the whiteboard. Always present as furniture; when `active` it glows and
 * shows a "Reunião" label. Avatars are walked to the seats by Office3D via
 * MovingAvatar's `meetingSeat` prop — this component only draws the room.
 */
export default function MeetingTable({ active, attendees = 0 }: Props) {
  const labelRef = useRef<Group>(null);
  const { width, depth, height } = MEETING_TABLE_SIZE;
  const [cx, , cz] = MEETING_TABLE_CENTER;

  // Gentle bob for the floating label when a meeting is on.
  useFrame((state) => {
    if (labelRef.current && active) {
      labelRef.current.position.y = 2.6 + Math.sin(state.clock.elapsedTime * 2) * 0.06;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Tabletop */}
      <Box args={[width, 0.15, depth]} position={[0, height, 0]} castShadow receiveShadow>
        <meshStandardMaterial
          color="#6b4f3a"
          roughness={0.5}
          emissive={active ? '#a855f7' : '#000000'}
          emissiveIntensity={active ? 0.18 : 0}
        />
      </Box>

      {/* Table legs */}
      {[
        [-width / 2 + 0.2, -depth / 2 + 0.2],
        [width / 2 - 0.2, -depth / 2 + 0.2],
        [-width / 2 + 0.2, depth / 2 - 0.2],
        [width / 2 - 0.2, depth / 2 - 0.2],
      ].map(([lx, lz], i) => (
        <Box key={i} args={[0.15, height, 0.15]} position={[lx, height / 2, lz]} castShadow>
          <meshStandardMaterial color="#3f2f22" roughness={0.6} />
        </Box>
      ))}

      {/* Chairs at every seat (positions are world-relative; subtract center) */}
      {MEETING_SEATS.map((seat, i) => {
        const lx = seat[0] - cx;
        const lz = seat[2] - cz;
        return (
          <VoxelChair
            key={i}
            position={[lx, 0, lz]}
            rotation={[0, facingTableY(seat), 0]}
            color={i === 0 || i === 7 ? '#6d28d9' : '#4a5568'}
          />
        );
      })}

      {/* Active-meeting label + glow ring on the floor */}
      {active && (
        <>
          <group ref={labelRef} position={[0, 2.6, 0]}>
            <Text fontSize={0.4} color="#c4b5fd" anchorX="center" anchorY="middle" outlineWidth={0.01} outlineColor="#1e1b4b">
              🤝 Reunião
            </Text>
            {attendees > 0 && (
              <Text position={[0, -0.45, 0]} fontSize={0.22} color="#a78bfa" anchorX="center" anchorY="middle">
                {attendees} participante{attendees !== 1 ? 's' : ''}
              </Text>
            )}
          </group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[width / 2 + 1.4, width / 2 + 1.7, 48]} />
            <meshBasicMaterial color="#a855f7" transparent opacity={0.35} />
          </mesh>
        </>
      )}
    </group>
  );
}
