'use client';

/**
 * Rotating emergency beacon shown on a console whose agent is `stuck`.
 * Built from additive-blended cones — deliberately NOT a shadow-casting
 * point light (one stuck fleet would melt the frame budget).
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Mesh, MeshStandardMaterial, AdditiveBlending } from 'three';

export default function AlarmBeacon({ position }: { position: [number, number, number] }) {
  const beamsRef = useRef<Group>(null);
  const domeRef = useRef<Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (beamsRef.current) beamsRef.current.rotation.y = t * 5;
    if (domeRef.current) {
      const mat = domeRef.current.material as MeshStandardMaterial;
      mat.emissiveIntensity = 1.2 + Math.sin(t * 10) * 0.8;
    }
  });

  return (
    <group position={position}>
      {/* Base */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.09, 0.11, 0.04, 12]} />
        <meshStandardMaterial color="#1f2937" metalness={0.6} />
      </mesh>
      {/* Dome */}
      <mesh ref={domeRef} position={[0, 0.1, 0]}>
        <sphereGeometry args={[0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={1.5} toneMapped={false} />
      </mesh>
      {/* Sweeping beams */}
      <group ref={beamsRef} position={[0, 0.1, 0]}>
        {[0, Math.PI].map((rot) => (
          <mesh key={rot} rotation={[0, rot, Math.PI / 2]} position={[Math.cos(rot) * 0.45, 0, Math.sin(rot) * 0.45]}>
            <coneGeometry args={[0.12, 0.9, 8, 1, true]} />
            <meshBasicMaterial
              color="#ef4444"
              transparent
              opacity={0.35}
              blending={AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
