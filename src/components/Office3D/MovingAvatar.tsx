'use client';

import { useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import VoxelAvatar from './VoxelAvatar';
import type { AgentConfig, AgentState } from './agentsConfig';

interface Obstacle {
  position: Vector3;
  radius: number;
}

/**
 * "Interest points" the idle avatar visits: cafeteira, whiteboard, plantas.
 * Coordinates roughly match the static furniture in Office3D.tsx. Each
 * idle target reroll has a chance of picking one of these instead of a
 * fully random spot, so the office feels populated instead of just chaotic.
 */
const INTEREST_POINTS: Array<{ x: number; z: number; weight: number }> = [
  { x: 6, z: -6, weight: 0.20 },   // máquina de café
  { x: -6, z: -6, weight: 0.15 },  // whiteboard
  { x: 0, z: -7, weight: 0.10 },   // arquivador
  { x: 7, z: 5, weight: 0.10 },    // planta
  { x: -7, z: 5, weight: 0.10 },   // planta
];

interface MovingAvatarProps {
  agent: AgentConfig;
  state?: AgentState;
  officeBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  obstacles: Obstacle[];
  otherAvatarPositions: Map<string, Vector3>;
  /**
   * Static desk positions, keyed by agent id. Used to lock a busy agent to
   * their own desk and to route the orchestrator toward whoever they're
   * currently delegating to or reviewing.
   */
  deskPositions: Map<string, Vector3>;
  onPositionUpdate: (id: string, pos: Vector3) => void;
}

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

export default function MovingAvatar({
  agent,
  state: stateProp,
  officeBounds,
  obstacles,
  otherAvatarPositions,
  deskPositions,
  onPositionUpdate
}: MovingAvatarProps) {
  const state = stateProp ?? IDLE_STATE;
  const groupRef = useRef<Group>(null);

  /**
   * What's the "anchor" of this avatar this frame?
   *
   *   - working / thinking / stuck      → own desk (offset 1 step forward so
   *                                       the avatar visually "sits at" it)
   *   - delegating / reviewing          → target desk (focusAgentId), offset
   *                                       to the side so we don't clip into
   *                                       the seated avatar
   *   - idle / offline                  → null (free wander)
   *
   * Returning null tells the reroll loop "pick a random or interest point".
   */
  const computeAnchorTarget = (): Vector3 | null => {
    const status = state.status;
    if (status === 'working' || status === 'thinking' || status === 'stuck') {
      const own = deskPositions.get(agent.id);
      if (own) return new Vector3(own.x, 0.6, own.z + 1); // 1 unit in front of the desk = where the chair is
    }
    if ((status === 'delegating' || status === 'reviewing') && state.focusAgentId) {
      const target = deskPositions.get(state.focusAgentId);
      if (target) {
        // Stand to the side of the focused agent's desk so we don't
        // overlap with whoever's working at it.
        const sideOffset = status === 'reviewing' ? 1.4 : 1.0;
        return new Vector3(target.x + sideOffset, 0.6, target.z + 0.8);
      }
    }
    return null;
  };
  
  // Posición inicial completamente aleatoria SIN colisiones
  const [initialPos] = useState(() => {
    let pos: Vector3;
    let attempts = 0;
    const minDistanceToObstacle = 1.5;

    // Intentar hasta 50 veces encontrar una posición sin colisión
    do {
      const x = Math.random() * (officeBounds.maxX - officeBounds.minX - 2) + officeBounds.minX + 1;
      const z = Math.random() * (officeBounds.maxZ - officeBounds.minZ - 2) + officeBounds.minZ + 1;
      pos = new Vector3(x, 0.6, z);

      // Verificar colisión con obstáculos
      let isFree = true;
      for (const obstacle of obstacles) {
        const distance = pos.distanceTo(obstacle.position);
        if (distance < obstacle.radius + minDistanceToObstacle) {
          isFree = false;
          break;
        }
      }

      if (isFree) break;
      attempts++;
    } while (attempts < 50);

    return pos;
  });

  const [targetPos, setTargetPos] = useState(initialPos);
  const currentPos = useRef(initialPos.clone());
  
  // Notificar posición inicial
  useEffect(() => {
    onPositionUpdate(agent.id, initialPos.clone());
  }, []);

  // Verificar si una posición está libre (sin colisiones)
  const isPositionFree = (pos: Vector3): boolean => {
    const minDistanceToObstacle = 1.5; // distancia mínima a muebles
    const minDistanceToAvatar = 1.2; // distancia mínima entre avatares

    // Verificar colisión con obstáculos
    for (const obstacle of obstacles) {
      const distance = pos.distanceTo(obstacle.position);
      if (distance < obstacle.radius + minDistanceToObstacle) {
        return false;
      }
    }

    // Verificar colisión con otros avatares
    for (const [otherId, otherPos] of otherAvatarPositions.entries()) {
      if (otherId === agent.id) continue;
      const distance = pos.distanceTo(otherPos);
      if (distance < minDistanceToAvatar) {
        return false;
      }
    }

    return true;
  };

  /**
   * Pick a fresh target. If the current state has an anchor (own desk,
   * focused agent's desk), snap to it. Otherwise reroll randomly with a
   * small bias toward interest points (cafeteira, whiteboard, plantas) so
   * the office actually looks lived-in.
   */
  const focusKey = state.focusAgentId ?? '';
  useEffect(() => {
    const reroll = () => {
      const anchor = computeAnchorTarget();
      if (anchor && isPositionFree(anchor)) {
        setTargetPos(anchor);
        return;
      }

      // No anchor (or it's occupied) → wander. With p≈sum(weights), pick an
      // interest point; otherwise pure random.
      const totalInterestWeight = INTEREST_POINTS.reduce((a, p) => a + p.weight, 0);
      const r = Math.random();
      if (r < totalInterestWeight) {
        let acc = 0;
        for (const p of INTEREST_POINTS) {
          acc += p.weight;
          if (r < acc) {
            const candidate = new Vector3(p.x + (Math.random() - 0.5) * 0.6, 0.6, p.z + (Math.random() - 0.5) * 0.6);
            if (isPositionFree(candidate)) {
              setTargetPos(candidate);
              return;
            }
            break;
          }
        }
      }

      // Pure random fallback
      let attempts = 0;
      let newPos: Vector3;
      do {
        const x = Math.random() * (officeBounds.maxX - officeBounds.minX) + officeBounds.minX;
        const z = Math.random() * (officeBounds.maxZ - officeBounds.minZ) + officeBounds.minZ;
        newPos = new Vector3(x, 0.6, z);
        attempts++;
      } while (!isPositionFree(newPos) && attempts < 20);
      if (attempts < 20) setTargetPos(newPos);
    };

    // Interval depends on state — "anchored" states reroll rarely (snap once
    // and stay there); idle rerolls frequently for the lived-in feel.
    const getInterval = (): number => {
      switch (state.status) {
        case 'idle':
          return 3000 + Math.random() * 3000;       // 3-6s
        case 'working':
          return 12000 + Math.random() * 6000;      // 12-18s (mostly at desk)
        case 'thinking':
          return 20000 + Math.random() * 10000;     // 20-30s (almost still)
        case 'delegating':
          return 7000 + Math.random() * 3000;       // 7-10s — Jarvis rotates between desks
        case 'reviewing':
          return 30000;                              // stays near the desk under review
        case 'stuck':
          return 60000;                              // frozen-ish
        case 'offline':
          return 60000;                              // dim, parked
        default:
          return 10000;
      }
    };

    // First target ~1s after mount, then on cadence.
    const timeout = setTimeout(reroll, 800);
    const interval = setInterval(reroll, getInterval());

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
    // We intentionally include focusKey so Jarvis re-targets immediately
    // when the orchestrator focus flips to a different sub-agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, focusKey]);

  // Mover suavemente hacia el objetivo
  useFrame((frameState, delta) => {
    if (!groupRef.current) return;

    // idle wanders quickly; orchestrator rotating between desks (delegating)
    // is brisk; working/thinking move slow (more "settled"); stuck/offline
    // basically don't move.
    const speed =
      state.status === 'idle'
        ? 1.5
        : state.status === 'delegating'
        ? 1.6
        : state.status === 'reviewing'
        ? 1.2
        : state.status === 'stuck' || state.status === 'offline'
        ? 0.2
        : 0.8;
    const moveSpeed = delta * speed;

    // Calcular nueva posición
    const newPos = currentPos.current.clone().lerp(targetPos, moveSpeed);

    // Verificar si la nueva posición es válida
    if (isPositionFree(newPos)) {
      currentPos.current.copy(newPos);
      groupRef.current.position.copy(currentPos.current);

      // Notificar la nueva posición
      onPositionUpdate(agent.id, currentPos.current.clone());

      // Rotar hacia la dirección del movimiento
      const direction = new Vector3().subVectors(targetPos, currentPos.current);
      if (direction.length() > 0.1) {
        const angle = Math.atan2(direction.x, direction.z);
        groupRef.current.rotation.y = angle;
      }
    } else {
      // Si hay colisión, buscar nuevo objetivo
      const x = Math.random() * (officeBounds.maxX - officeBounds.minX) + officeBounds.minX;
      const z = Math.random() * (officeBounds.maxZ - officeBounds.minZ) + officeBounds.minZ;
      const newTarget = new Vector3(x, 0.6, z);
      if (isPositionFree(newTarget)) {
        setTargetPos(newTarget);
      }
    }
  });

  return (
    <group ref={groupRef} scale={3}>
      <VoxelAvatar
        agent={agent}
        position={[0, 0, 0]}
        isWorking={state.status === 'working'}
        isThinking={state.status === 'thinking' || state.status === 'reviewing'}
        isError={state.status === 'stuck'}
      />
    </group>
  );
}
