'use client';

/**
 * Glass-walled war room on the right side of Mission Control. The team
 * convenes here when ≥2 specialists have active tasks; the room "wakes up"
 * (sign + table glow) while a meeting is on.
 */
import { Box, Text } from '@react-three/drei';
import VoxelChair from '../../VoxelChair';
import { WAR_ROOM, WAR_SEATS } from './layout';

interface WarRoomGlassProps {
  active: boolean;
  attendees: number;
}

const GLASS_HEIGHT = 3.2;

export default function WarRoomGlass({ active, attendees }: WarRoomGlassProps) {
  const [cx, , cz] = WAR_ROOM.center;
  const [w, d] = WAR_ROOM.size;
  const [tw, td] = WAR_ROOM.tableSize;

  return (
    <group position={[cx, 0, cz]}>
      {/* Glass walls (no wall on the -x side = entrance toward the floor) */}
      {/* back (-z) */}
      <GlassPanel size={[w, GLASS_HEIGHT, 0.06]} position={[0, GLASS_HEIGHT / 2, -d / 2]} />
      {/* front (+z) */}
      <GlassPanel size={[w, GLASS_HEIGHT, 0.06]} position={[0, GLASS_HEIGHT / 2, d / 2]} />
      {/* right (+x) */}
      <GlassPanel size={[0.06, GLASS_HEIGHT, d]} position={[w / 2, GLASS_HEIGHT / 2, 0]} />
      {/* entrance posts on the -x side */}
      <Box args={[0.1, GLASS_HEIGHT, 0.1]} position={[-w / 2, GLASS_HEIGHT / 2, -d / 2]} castShadow>
        <meshStandardMaterial color="#1e293b" metalness={0.6} />
      </Box>
      <Box args={[0.1, GLASS_HEIGHT, 0.1]} position={[-w / 2, GLASS_HEIGHT / 2, d / 2]} castShadow>
        <meshStandardMaterial color="#1e293b" metalness={0.6} />
      </Box>

      {/* Conference table */}
      <Box args={[tw, 0.09, td]} position={[0, 1.0, 0]} castShadow receiveShadow>
        <meshStandardMaterial
          color={active ? '#1d3a5f' : '#1e293b'}
          emissive={active ? '#2563eb' : '#000000'}
          emissiveIntensity={active ? 0.25 : 0}
          metalness={0.3}
          roughness={0.5}
        />
      </Box>
      {/* Table legs */}
      {[-tw / 2 + 0.25, tw / 2 - 0.25].map((x) =>
        [-td / 2 + 0.2, td / 2 - 0.2].map((z) => (
          <Box key={`${x}-${z}`} args={[0.1, 0.95, 0.1]} position={[x, 0.48, z]} castShadow>
            <meshStandardMaterial color="#0f172a" />
          </Box>
        )),
      )}

      {/* Chairs around the table (world seats → local coords) */}
      {WAR_SEATS.map(([sx, sz], i) => {
        const lx = sx - cx;
        const lz = sz - cz;
        const yaw = Math.atan2(-lx, -lz);
        return (
          <group key={i} scale={2}>
            <VoxelChair position={[lx / 2, 0, lz / 2]} rotation={[0, yaw, 0]} color="#27272a" />
          </group>
        );
      })}

      {/* Sign */}
      <Text
        position={[0, GLASS_HEIGHT + 0.35, 0]}
        fontSize={0.24}
        color={active ? '#f97316' : '#64748b'}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.012}
        outlineColor="#000000"
      >
        {active ? `🔴 WAR ROOM — ${attendees} em reunião` : 'WAR ROOM'}
      </Text>
    </group>
  );
}

function GlassPanel({ size, position }: { size: [number, number, number]; position: [number, number, number] }) {
  return (
    <Box args={size} position={position}>
      <meshStandardMaterial color="#7dd3fc" transparent opacity={0.12} metalness={0.2} roughness={0.05} />
    </Box>
  );
}
