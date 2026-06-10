'use client';

/**
 * Reception of the Startup Campus: front counter + the envelope conveyor
 * along the front wall where new tasks physically arrive. The belt has an
 * animated stripe texture-free look (moving rollers via thin boxes).
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import { Group } from 'three';
import { RECEPTION } from './layout';

export default function Reception({ inboxCount }: { inboxCount: number }) {
  const [cx, , cz] = RECEPTION.counter;
  const [cw, ch, cd] = RECEPTION.counterSize;
  const rollersRef = useRef<Group>(null);

  // Subtle roller motion sells "conveyor" without a real texture scroll.
  useFrame(({ clock }) => {
    if (!rollersRef.current) return;
    rollersRef.current.children.forEach((roller, i) => {
      roller.rotation.x = clock.elapsedTime * 2 + i;
    });
  });

  return (
    <group>
      {/* Counter */}
      <group position={[cx, 0, cz]}>
        <Box args={[cw, ch, cd]} position={[0, ch / 2, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#334155" roughness={0.7} />
        </Box>
        <Box args={[cw + 0.2, 0.08, cd + 0.2]} position={[0, ch + 0.04, 0]} castShadow>
          <meshStandardMaterial color="#94a3b8" metalness={0.3} roughness={0.4} />
        </Box>
        {/* Bell */}
        <Box args={[0.12, 0.08, 0.12]} position={[cw / 2 - 0.4, ch + 0.12, 0.2]} castShadow>
          <meshStandardMaterial color="#facc15" metalness={0.7} emissive="#facc15" emissiveIntensity={0.2} />
        </Box>
        <Text
          position={[0, ch + 0.85, 0.1]}
          fontSize={0.22}
          color="#e2e8f0"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.012}
          outlineColor="#000000"
        >
          📬 RECEPÇÃO
        </Text>
        <Text position={[0, ch + 0.55, 0.1]} fontSize={0.13} color="#94a3b8" anchorX="center" anchorY="middle">
          {inboxCount > 0 ? `${inboxCount} missão(ões) aguardando` : 'caixa de entrada vazia'}
        </Text>
      </group>

      {/* Conveyor belt along the front wall */}
      <group position={[cx, 0, RECEPTION.beltZ]}>
        {/* Frame */}
        <Box args={[6.4, 0.12, 0.7]} position={[0, RECEPTION.beltY - 0.06, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#1e293b" />
        </Box>
        {/* Legs */}
        {[-2.9, 0, 2.9].map((x) => (
          <Box key={x} args={[0.1, RECEPTION.beltY - 0.12, 0.1]} position={[x, (RECEPTION.beltY - 0.12) / 2, 0]} castShadow>
            <meshStandardMaterial color="#0f172a" />
          </Box>
        ))}
        {/* Rollers */}
        <group ref={rollersRef}>
          {Array.from({ length: 9 }, (_, i) => -2.8 + i * 0.7).map((x, i) => (
            <mesh key={i} position={[x, RECEPTION.beltY, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.05, 0.05, 0.6, 8]} />
              <meshStandardMaterial color="#475569" metalness={0.5} />
            </mesh>
          ))}
        </group>
        {/* Inlet chute on the wall */}
        <Box args={[0.9, 0.6, 0.3]} position={[3.4, RECEPTION.beltY + 0.25, -0.25]} castShadow>
          <meshStandardMaterial color="#0f172a" />
        </Box>
        <Text position={[3.4, RECEPTION.beltY + 0.75, 0]} fontSize={0.12} color="#64748b" anchorX="center">
          ⬇ novas missões
        </Text>
      </group>
    </group>
  );
}
