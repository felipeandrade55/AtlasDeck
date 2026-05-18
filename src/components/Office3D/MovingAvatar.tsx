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
  onPositionUpdate: (id: string, pos: Vector3) => void;
}

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

export default function MovingAvatar({
  agent,
  state: stateProp,
  officeBounds,
  obstacles,
  otherAvatarPositions,
  onPositionUpdate
}: MovingAvatarProps) {
  const state = stateProp ?? IDLE_STATE;
  const groupRef = useRef<Group>(null);
  
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

  // Cambiar objetivo cada 5-10 segundos (depende del estado)
  useEffect(() => {
    const getNewTarget = () => {
      let attempts = 0;
      let newPos: Vector3;

      // Intentar encontrar una posición libre (máximo 20 intentos)
      do {
        const x = Math.random() * (officeBounds.maxX - officeBounds.minX) + officeBounds.minX;
        const z = Math.random() * (officeBounds.maxZ - officeBounds.minZ) + officeBounds.minZ;
        newPos = new Vector3(x, 0.6, z);
        attempts++;
      } while (!isPositionFree(newPos) && attempts < 20);

      if (attempts < 20) {
        setTargetPos(newPos);
      }
    };

    // Idle: moverse más frecuentemente
    // Working: moverse menos
    // Thinking: moverse muy poco
    // Error: quedarse quieto
    const getInterval = () => {
      switch (state.status) {
        case 'idle':
          return 3000 + Math.random() * 3000; // 3-6s
        case 'working':
          return 8000 + Math.random() * 7000; // 8-15s
        case 'thinking':
          return 15000 + Math.random() * 10000; // 15-25s
        case 'error':
          return 30000; // casi quieto
        default:
          return 10000;
      }
    };

    // Primer objetivo después de montar
    const timeout = setTimeout(getNewTarget, 1000);
    const interval = setInterval(getNewTarget, getInterval());
    
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [state.status]);

  // Mover suavemente hacia el objetivo
  useFrame((frameState, delta) => {
    if (!groupRef.current) return;

    const speed = state.status === 'idle' ? 1.5 : 0.8; // idle se mueve más rápido
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
        isThinking={state.status === 'thinking'}
        isError={state.status === 'error'}
      />
    </group>
  );
}
