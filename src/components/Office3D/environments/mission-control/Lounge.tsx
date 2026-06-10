'use client';

/**
 * Break area on the left side of Mission Control: sofa + TV (with a games
 * console) and an arcade cabinet. Idle agents claim these POIs — seat 0 of
 * the sofa "plays" the console, the arcade fits one player.
 */
import Sofa from '../../shared/furniture/Sofa';
import TVSet from '../../shared/furniture/TVSet';
import ArcadeCabinet from '../../shared/furniture/ArcadeCabinet';
import PlantPot from '../../PlantPot';

export default function Lounge() {
  return (
    <group>
      {/* Rug */}
      <mesh position={[-10.4, 0.012, 4.6]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5.6, 4.4]} />
        <meshStandardMaterial color="#27214a" roughness={1} />
      </mesh>

      {/* TV against the left wall, facing the sofa (+x) */}
      <TVSet position={[-12.3, 0, 4.5]} rotation={[0, Math.PI / 2, 0]} />

      {/* Sofa facing the TV (-x) */}
      <Sofa position={[-8.6, 0, 4.5]} rotation={[0, -Math.PI / 2, 0]} />

      {/* Arcade cabinet, front toward the room (+x) */}
      <ArcadeCabinet position={[-12.35, 0, 7.6]} rotation={[0, Math.PI / 2, 0]} />

      <PlantPot position={[-11.8, 0, 1.9]} size="medium" />
    </group>
  );
}
