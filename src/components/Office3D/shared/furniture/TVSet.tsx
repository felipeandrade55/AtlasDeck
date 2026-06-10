'use client';

/**
 * Lounge TV on a low stand, playing the stylized `tvShow` program (with a
 * games console under it — sofa seat 0 "plays" it). Screen faces local +z.
 */
import { Box } from '@react-three/drei';
import ScreenSurface from '../screens/ScreenSurface';

interface TVSetProps {
  position: [number, number, number];
  rotation?: [number, number, number];
}

export default function TVSet({ position, rotation = [0, 0, 0] }: TVSetProps) {
  return (
    <group position={position} rotation={rotation}>
      {/* Stand */}
      <Box args={[2.4, 0.5, 0.6]} position={[0, 0.25, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#1f2937" roughness={0.7} />
      </Box>
      {/* Games console on the stand */}
      <Box args={[0.45, 0.1, 0.35]} position={[0.7, 0.55, 0.05]} castShadow>
        <meshStandardMaterial color="#0f172a" metalness={0.4} />
      </Box>
      {/* TV frame */}
      <Box args={[2.3, 1.35, 0.1]} position={[0, 1.45, 0]} castShadow>
        <meshStandardMaterial color="#0b1220" metalness={0.5} roughness={0.4} />
      </Box>
      <ScreenSurface size={[2.14, 1.2]} program="tvShow" color="#38bdf8" position={[0, 1.45, 0.06]} fps={8} />
    </group>
  );
}
