'use client';

/**
 * Campus break area on the right wall: sofa + TV with games console and
 * the coffee bar (copa). Idle agents chat here with speech bubbles.
 */
import Sofa from '../../shared/furniture/Sofa';
import TVSet from '../../shared/furniture/TVSet';
import CoffeeMachine from '../../CoffeeMachine';
import PlantPot from '../../PlantPot';
import { Box, Text } from '@react-three/drei';

export default function CampusLounge() {
  return (
    <group>
      {/* Rug */}
      <mesh position={[10.9, 0.012, 0.3]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4.6, 4.6]} />
        <meshStandardMaterial color="#3b3354" roughness={1} />
      </mesh>

      {/* TV on the right wall, facing the sofa (-x) */}
      <TVSet position={[12.45, 0, 0.2]} rotation={[0, -Math.PI / 2, 0]} />
      {/* Sofa facing the TV (+x) */}
      <Sofa position={[9.6, 0, 0.2]} rotation={[0, Math.PI / 2, 0]} color="#0e7490" />

      {/* Copa: coffee machine on a small counter */}
      <group position={[12.25, 0, 3.6]}>
        <Box args={[0.9, 0.9, 0.9]} position={[0, 0.45, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#475569" roughness={0.7} />
        </Box>
        <group rotation={[0, -Math.PI / 2, 0]} position={[0, 0.9, 0]}>
          <CoffeeMachine position={[0, 0, 0]} />
        </group>
        <Text position={[-0.7, 1.7, 0]} fontSize={0.14} color="#94a3b8" anchorX="center" anchorY="middle">
          ☕ copa
        </Text>
      </group>

      <PlantPot position={[12.2, 0, -2.6]} size="large" />
    </group>
  );
}
