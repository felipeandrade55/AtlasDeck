'use client';

/**
 * Lightweight speech bubble: drei <Billboard> + <Text> over a plane.
 * Deliberately NOT <Html> — several idle agents can chat at once and each
 * Html instance costs a DOM subtree + per-frame matrix work.
 */
import { Billboard, Text } from '@react-three/drei';

interface SpeechBubbleProps {
  text: string;
  position?: [number, number, number];
}

export default function SpeechBubble({ text, position = [0, 0.62, 0] }: SpeechBubbleProps) {
  const width = Math.min(0.7, 0.12 + text.length * 0.035);
  return (
    <Billboard position={position}>
      <mesh>
        <planeGeometry args={[width, 0.14]} />
        <meshBasicMaterial color="#f8fafc" transparent opacity={0.92} />
      </mesh>
      {/* tail */}
      <mesh position={[0, -0.085, 0]} rotation={[0, 0, Math.PI / 4]}>
        <planeGeometry args={[0.04, 0.04]} />
        <meshBasicMaterial color="#f8fafc" transparent opacity={0.92} />
      </mesh>
      <Text position={[0, 0, 0.005]} fontSize={0.065} color="#0f172a" anchorX="center" anchorY="middle">
        {text}
      </Text>
    </Billboard>
  );
}
