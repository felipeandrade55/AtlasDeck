'use client';

/**
 * Three-seat voxel sofa for the lounge. Origin at floor center; seats face
 * local +z (rotate the group to aim it at the TV).
 */
import { Box } from '@react-three/drei';

interface SofaProps {
  position: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

export default function Sofa({ position, rotation = [0, 0, 0], color = '#7c3aed' }: SofaProps) {
  const darker = '#5b21b6';
  return (
    <group position={position} rotation={rotation}>
      {/* Base / seats */}
      <Box args={[3.2, 0.55, 1.1]} position={[0, 0.28, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={color} roughness={0.85} />
      </Box>
      {/* Backrest */}
      <Box args={[3.2, 0.8, 0.3]} position={[0, 0.85, -0.4]} castShadow>
        <meshStandardMaterial color={color} roughness={0.85} />
      </Box>
      {/* Armrests */}
      {[-1.45, 1.45].map((x) => (
        <Box key={x} args={[0.3, 0.45, 1.1]} position={[x, 0.7, 0]} castShadow>
          <meshStandardMaterial color={darker} roughness={0.85} />
        </Box>
      ))}
      {/* Seat cushions (visual split) */}
      {[-1.0, 0, 1.0].map((x) => (
        <Box key={x} args={[0.92, 0.12, 0.95]} position={[x, 0.6, 0.05]} castShadow>
          <meshStandardMaterial color={darker} roughness={0.9} />
        </Box>
      ))}
      {/* Feet */}
      {[-1.4, 1.4].map((x) =>
        [-0.4, 0.4].map((z) => (
          <Box key={`${x}${z}`} args={[0.1, 0.12, 0.1]} position={[x, 0.06, z]}>
            <meshStandardMaterial color="#1f2937" />
          </Box>
        )),
      )}
    </group>
  );
}
