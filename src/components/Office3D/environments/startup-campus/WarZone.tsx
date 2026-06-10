'use client';

/**
 * Open war-room corner of the campus: big meeting table + telão on the
 * back wall showing the pipeline. Lights up while a meeting is on.
 */
import { Box, Text } from '@react-three/drei';
import VoxelChair from '../../VoxelChair';
import ScreenSurface from '../../shared/screens/ScreenSurface';
import { WAR_ZONE } from './layout';

const SEATS_LOCAL: Array<[number, number]> = [
  [2.0, 0],
  [-0.8, -1.1],
  [0.5, -1.1],
  [-0.8, 1.1],
  [0.5, 1.1],
  [-2.0, 0],
];

export default function WarZone({ active, attendees }: { active: boolean; attendees: number }) {
  const [cx, , cz] = WAR_ZONE.tableCenter;
  const [tw, td] = WAR_ZONE.tableSize;

  return (
    <group>
      <group position={[cx, 0, cz]}>
        {/* Table */}
        <Box args={[tw, 0.09, td]} position={[0, 1.0, 0]} castShadow receiveShadow>
          <meshStandardMaterial
            color={active ? '#155e44' : '#1e293b'}
            emissive={active ? '#10b981' : '#000000'}
            emissiveIntensity={active ? 0.18 : 0}
            roughness={0.5}
          />
        </Box>
        {[-tw / 2 + 0.25, tw / 2 - 0.25].map((x) =>
          [-td / 2 + 0.2, td / 2 - 0.2].map((z) => (
            <Box key={`${x}${z}`} args={[0.1, 0.95, 0.1]} position={[x, 0.48, z]} castShadow>
              <meshStandardMaterial color="#0f172a" />
            </Box>
          )),
        )}
        {/* Chairs */}
        {SEATS_LOCAL.map(([lx, lz], i) => {
          const yaw = Math.atan2(-lx, -lz);
          return (
            <group key={i} scale={2}>
              <VoxelChair position={[lx / 2, 0, lz / 2]} rotation={[0, yaw, 0]} color="#3f3f46" />
            </group>
          );
        })}
        <Text position={[0, 3.1, 0]} fontSize={0.22} color={active ? '#f97316' : '#64748b'} anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor="#000000">
          {active ? `🔴 REUNIÃO — ${attendees} presentes` : 'WAR ROOM'}
        </Text>
      </group>

      {/* Telão on the back wall */}
      <group position={WAR_ZONE.screenCenter}>
        <Box args={[4.6, 2.6, 0.15]} castShadow>
          <meshStandardMaterial color="#0b1220" metalness={0.5} roughness={0.4} />
        </Box>
        <ScreenSurface size={[4.3, 2.3]} program="kanbanColumns" color="#38bdf8" position={[0, 0, 0.09]} resolution={[160, 100]} />
      </group>
    </group>
  );
}
