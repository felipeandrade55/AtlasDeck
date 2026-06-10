'use client';

/**
 * Voxel accessories that personalize each agent by role: tiny <Box>
 * composites parented to the head or torso. Picked via roleAccessories.ts.
 */
import { Box } from '@react-three/drei';

export type Accessory = 'tie' | 'headset' | 'glasses' | 'cap';

/** Parented inside the HEAD group (origin = head center). */
export function HeadAccessory({ type }: { type: Accessory }) {
  switch (type) {
    case 'headset':
      return (
        <group>
          <Box args={[0.05, 0.07, 0.07]} position={[-0.115, 0, 0]} castShadow>
            <meshStandardMaterial color="#111827" />
          </Box>
          <Box args={[0.05, 0.07, 0.07]} position={[0.115, 0, 0]} castShadow>
            <meshStandardMaterial color="#111827" />
          </Box>
          <Box args={[0.26, 0.03, 0.03]} position={[0, 0.115, 0]} castShadow>
            <meshStandardMaterial color="#1f2937" />
          </Box>
          {/* mic boom */}
          <Box args={[0.02, 0.02, 0.09]} position={[-0.1, -0.05, 0.07]} castShadow>
            <meshStandardMaterial color="#374151" />
          </Box>
        </group>
      );
    case 'glasses':
      return (
        <group position={[0, 0.02, 0.105]}>
          <Box args={[0.07, 0.05, 0.015]} position={[-0.05, 0, 0]}>
            <meshStandardMaterial color="#0f172a" metalness={0.5} />
          </Box>
          <Box args={[0.07, 0.05, 0.015]} position={[0.05, 0, 0]}>
            <meshStandardMaterial color="#0f172a" metalness={0.5} />
          </Box>
          <Box args={[0.03, 0.015, 0.015]} position={[0, 0.01, 0]}>
            <meshStandardMaterial color="#0f172a" />
          </Box>
        </group>
      );
    case 'cap':
      return (
        <group>
          <Box args={[0.22, 0.05, 0.22]} position={[0, 0.115, 0]} castShadow>
            <meshStandardMaterial color="#dc2626" />
          </Box>
          <Box args={[0.2, 0.02, 0.1]} position={[0, 0.1, 0.15]} castShadow>
            <meshStandardMaterial color="#b91c1c" />
          </Box>
        </group>
      );
    default:
      return null;
  }
}

/** Parented inside the HIPS group (origin = avatar base). */
export function TorsoAccessory({ type }: { type: Accessory }) {
  if (type !== 'tie') return null;
  return (
    <group position={[0, 0.17, 0.065]}>
      {/* knot */}
      <Box args={[0.04, 0.03, 0.015]} position={[0, 0.05, 0]}>
        <meshStandardMaterial color="#facc15" />
      </Box>
      {/* blade */}
      <Box args={[0.035, 0.12, 0.012]} position={[0, -0.035, 0]}>
        <meshStandardMaterial color="#eab308" />
      </Box>
    </group>
  );
}
