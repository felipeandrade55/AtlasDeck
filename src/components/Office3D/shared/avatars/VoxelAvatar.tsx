'use client';

/**
 * Evolved voxel avatar: same proportions as the classic one, but driven by
 * a declarative pose system (avatarPoses.ts), role accessories and
 * optional held props (game controller, coffee mug). The component itself
 * stays thin — all motion lives in avatarPoses.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import { Group } from 'three';
import type { PoseName } from '../behavior/behaviorTypes';
import { applyStaticPose, animatePose, type AvatarRefs } from './avatarPoses';
import { HeadAccessory, TorsoAccessory, type Accessory } from './accessories';
import { accessoriesFor } from './roleAccessories';
import SpeechBubble from './SpeechBubble';

export interface VoxelAvatarAgent {
  id: string;
  color: string;
  emoji: string;
  role: string;
}

interface VoxelAvatarProps {
  agent: VoxelAvatarAgent;
  pose: PoseName;
  /** 'error' = frown + sparks (stuck). */
  mood?: 'neutral' | 'error';
  /** Blue thought particles + head bob. */
  thinking?: boolean;
  /** Overrides the role-derived accessories when provided. */
  accessories?: Accessory[];
  heldProp?: 'controller' | 'coffee' | null;
  speechBubble?: string | null;
}

export default function VoxelAvatar({
  agent,
  pose,
  mood = 'neutral',
  thinking = false,
  accessories,
  heldProp = null,
  speechBubble = null,
}: VoxelAvatarProps) {
  const rootRef = useRef<Group>(null);
  const hipsRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const leftLegRef = useRef<Group>(null);
  const rightLegRef = useRef<Group>(null);

  const acc = useMemo(
    () => accessories ?? accessoriesFor(agent.id, agent.role),
    [accessories, agent.id, agent.role],
  );

  const getRefs = (): AvatarRefs | null => {
    if (
      !rootRef.current ||
      !hipsRef.current ||
      !headRef.current ||
      !leftArmRef.current ||
      !rightArmRef.current ||
      !leftLegRef.current ||
      !rightLegRef.current
    ) {
      return null;
    }
    return {
      root: rootRef.current,
      hips: hipsRef.current,
      head: headRef.current,
      leftArm: leftArmRef.current,
      rightArm: rightArmRef.current,
      leftLeg: leftLegRef.current,
      rightLeg: rightLegRef.current,
    };
  };

  // Static placement on pose change…
  useEffect(() => {
    const refs = getRefs();
    if (refs) applyStaticPose(refs, pose);
  }, [pose]);

  // …oscillation + state effects every frame.
  useFrame(({ clock }) => {
    const refs = getRefs();
    if (!refs) return;
    const t = clock.elapsedTime;
    animatePose(refs, pose, t);
    if (thinking) {
      refs.head.position.y = 0.35 + Math.sin(t * 2) * 0.03;
      refs.head.rotation.y = Math.sin(t) * 0.1;
    }
    if (mood === 'error') {
      refs.head.rotation.x = Math.sin(t * 5) * 0.1;
      refs.head.rotation.z = Math.sin(t * 4) * 0.15;
    }
  });

  const skinColor = '#ffa07a';
  const shirtColor = agent.color;
  const pantsColor = '#4a5568';

  return (
    <group ref={rootRef}>
      <group ref={hipsRef}>
        {/* HEAD */}
        <group ref={headRef} position={[0, 0.35, 0]}>
          <Box args={[0.2, 0.2, 0.2]} castShadow>
            <meshStandardMaterial color={skinColor} />
          </Box>
          {/* Eyes */}
          <Box args={[0.04, 0.04, 0.02]} position={[-0.05, 0.02, 0.11]}>
            <meshStandardMaterial color="#1f2937" />
          </Box>
          <Box args={[0.04, 0.04, 0.02]} position={[0.05, 0.02, 0.11]}>
            <meshStandardMaterial color="#1f2937" />
          </Box>
          {/* Mouth — smile or frown */}
          {mood !== 'error' ? (
            <Box args={[0.08, 0.02, 0.01]} position={[0, -0.04, 0.11]}>
              <meshStandardMaterial color="#000000" />
            </Box>
          ) : (
            <Box args={[0.08, 0.02, 0.01]} position={[0, -0.06, 0.11]} rotation={[0, 0, Math.PI]}>
              <meshStandardMaterial color="#ef4444" />
            </Box>
          )}
          {/* Emoji badge */}
          <Text position={[0, 0.08, 0.11]} fontSize={0.08} color="white" anchorX="center" anchorY="middle">
            {agent.emoji}
          </Text>
          {acc.map((a) => (
            <HeadAccessory key={a} type={a} />
          ))}
          {/* Thinking particles */}
          {thinking && (
            <>
              <mesh position={[-0.15, 0.15, 0]}>
                <sphereGeometry args={[0.02]} />
                <meshBasicMaterial color="#3b82f6" transparent opacity={0.6} />
              </mesh>
              <mesh position={[-0.18, 0.2, 0]}>
                <sphereGeometry args={[0.03]} />
                <meshBasicMaterial color="#3b82f6" transparent opacity={0.5} />
              </mesh>
              <mesh position={[-0.22, 0.26, 0]}>
                <sphereGeometry args={[0.04]} />
                <meshBasicMaterial color="#3b82f6" transparent opacity={0.4} />
              </mesh>
            </>
          )}
        </group>

        {/* BODY */}
        <Box args={[0.2, 0.25, 0.12]} position={[0, 0.125, 0]} castShadow>
          <meshStandardMaterial color={shirtColor} />
        </Box>
        {acc.map((a) => (
          <TorsoAccessory key={a} type={a} />
        ))}

        {/* ARMS — pivot at the shoulder */}
        <group ref={leftArmRef} position={[-0.12, 0.18, 0]}>
          <Box args={[0.08, 0.2, 0.08]} position={[0, -0.1, 0]} castShadow>
            <meshStandardMaterial color={shirtColor} />
          </Box>
          <Box args={[0.08, 0.06, 0.08]} position={[0, -0.23, 0]} castShadow>
            <meshStandardMaterial color={skinColor} />
          </Box>
        </group>
        <group ref={rightArmRef} position={[0.12, 0.18, 0]}>
          <Box args={[0.08, 0.2, 0.08]} position={[0, -0.1, 0]} castShadow>
            <meshStandardMaterial color={shirtColor} />
          </Box>
          <Box args={[0.08, 0.06, 0.08]} position={[0, -0.23, 0]} castShadow>
            <meshStandardMaterial color={skinColor} />
          </Box>
        </group>

        {/* Held prop floats where the hands meet */}
        {heldProp === 'controller' && (
          <group position={[0, 0.1, 0.22]}>
            <Box args={[0.14, 0.05, 0.08]} castShadow>
              <meshStandardMaterial color="#18181b" />
            </Box>
            <Box args={[0.02, 0.02, 0.02]} position={[-0.04, 0.03, 0]}>
              <meshStandardMaterial color="#ef4444" />
            </Box>
            <Box args={[0.02, 0.02, 0.02]} position={[0.04, 0.03, 0]}>
              <meshStandardMaterial color="#3b82f6" />
            </Box>
          </group>
        )}
        {heldProp === 'coffee' && (
          <group position={[0.1, 0.12, 0.16]}>
            <Box args={[0.06, 0.08, 0.06]} castShadow>
              <meshStandardMaterial color="#f8fafc" />
            </Box>
            <Box args={[0.05, 0.012, 0.05]} position={[0, 0.05, 0]}>
              <meshStandardMaterial color="#78350f" />
            </Box>
          </group>
        )}
      </group>

      {/* LEGS — pivot at the hip joint so sitting reads correctly */}
      <group ref={leftLegRef} position={[-0.05, 0, 0]}>
        <Box args={[0.09, 0.18, 0.09]} position={[0, -0.09, 0]} castShadow>
          <meshStandardMaterial color={pantsColor} />
        </Box>
        <Box args={[0.09, 0.04, 0.12]} position={[0, -0.2, 0.015]} castShadow>
          <meshStandardMaterial color="#1f2937" />
        </Box>
      </group>
      <group ref={rightLegRef} position={[0.05, 0, 0]}>
        <Box args={[0.09, 0.18, 0.09]} position={[0, -0.09, 0]} castShadow>
          <meshStandardMaterial color={pantsColor} />
        </Box>
        <Box args={[0.09, 0.04, 0.12]} position={[0, -0.2, 0.015]} castShadow>
          <meshStandardMaterial color="#1f2937" />
        </Box>
      </group>

      {/* Error sparks */}
      {mood === 'error' && (
        <>
          <mesh position={[0.15, 0.3, 0]}>
            <boxGeometry args={[0.02, 0.02, 0.02]} />
            <meshBasicMaterial color="#ef4444" />
          </mesh>
          <mesh position={[-0.15, 0.25, 0]}>
            <boxGeometry args={[0.02, 0.02, 0.02]} />
            <meshBasicMaterial color="#f59e0b" />
          </mesh>
        </>
      )}

      {speechBubble && <SpeechBubble text={speechBubble} />}
    </group>
  );
}
