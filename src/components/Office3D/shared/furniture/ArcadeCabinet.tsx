'use client';

/**
 * Voxel arcade cabinet with a self-playing pong screen. Front (joystick
 * side) faces local +z.
 */
import { Box, Text } from '@react-three/drei';
import ScreenSurface from '../screens/ScreenSurface';

interface ArcadeCabinetProps {
  position: [number, number, number];
  rotation?: [number, number, number];
}

export default function ArcadeCabinet({ position, rotation = [0, 0, 0] }: ArcadeCabinetProps) {
  return (
    <group position={position} rotation={rotation}>
      {/* Body */}
      <Box args={[0.9, 1.7, 0.8]} position={[0, 0.85, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#312e81" roughness={0.7} />
      </Box>
      {/* Marquee */}
      <Box args={[0.95, 0.25, 0.82]} position={[0, 1.82, 0]} castShadow>
        <meshStandardMaterial color="#facc15" emissive="#facc15" emissiveIntensity={0.4} toneMapped={false} />
      </Box>
      <Text position={[0, 1.82, 0.45]} fontSize={0.13} color="#1e1b4b" anchorX="center" anchorY="middle">
        ATLAS ARCADE
      </Text>
      {/* Screen, tilted back */}
      <group position={[0, 1.32, 0.36]} rotation={[-0.28, 0, 0]}>
        <Box args={[0.74, 0.6, 0.06]}>
          <meshStandardMaterial color="#0b1220" />
        </Box>
        <ScreenSurface size={[0.66, 0.52]} program="pong" color="#4ade80" position={[0, 0, 0.035]} fps={10} />
      </group>
      {/* Control deck */}
      <Box args={[0.86, 0.1, 0.4]} position={[0, 0.95, 0.5]} rotation={[0.15, 0, 0]} castShadow>
        <meshStandardMaterial color="#1e1b4b" />
      </Box>
      {/* Joystick + buttons */}
      <Box args={[0.06, 0.14, 0.06]} position={[-0.2, 1.06, 0.52]}>
        <meshStandardMaterial color="#ef4444" />
      </Box>
      {[0.08, 0.22].map((x) => (
        <Box key={x} args={[0.07, 0.04, 0.07]} position={[x, 1.0, 0.55]}>
          <meshStandardMaterial color={x === 0.08 ? '#22c55e' : '#3b82f6'} />
        </Box>
      ))}
    </group>
  );
}
