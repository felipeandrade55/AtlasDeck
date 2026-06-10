'use client';

/**
 * Renders every task-envelope and animates it between its physical
 * stations: conveyor → (carried by the owner) → desk → QA stack.
 *
 * A carried envelope is NOT parented to the avatar — it reads the owner's
 * live position from the transient store inside useFrame and floats at
 * "hand height" in front of them; when the owner gets close to their desk
 * it settles onto the desktop. Cross-tree parenting would couple the scene
 * graphs for no benefit.
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box } from '@react-three/drei';
import { Group, Vector3 } from 'three';
import { useOfficeStore } from '../../../shared/data/officeStore';
import { RECEPTION, QA_DESK, type DeskSlot } from '../layout';
import type { EnvelopeEntity } from './useEnvelopes';

interface EnvelopesProps {
  envelopes: Map<string, EnvelopeEntity>;
  desks: DeskSlot[];
  /** Accent color per agent (envelope sticker). */
  agentColors: Map<string, string>;
}

export default function Envelopes({ envelopes, desks, agentColors }: EnvelopesProps) {
  const deskById = new Map(desks.map((d) => [d.agentId, d.position]));
  return (
    <group>
      {Array.from(envelopes.values()).map((e) => (
        <EnvelopeMesh
          key={e.taskId}
          entity={e}
          deskPos={e.agentId ? deskById.get(e.agentId) ?? null : null}
          color={(e.agentId && agentColors.get(e.agentId)) || '#94a3b8'}
        />
      ))}
    </group>
  );
}

const CARRY_HEIGHT = 1.55;
const DESK_SETTLE_DIST = 1.8;

function EnvelopeMesh({
  entity,
  deskPos,
  color,
}: {
  entity: EnvelopeEntity;
  deskPos: [number, number, number] | null;
  color: string;
}) {
  const ref = useRef<Group>(null);
  const settled = useRef(false);

  useFrame((_, delta) => {
    const group = ref.current;
    if (!group) return;

    const target = new Vector3();
    let spin = false;

    switch (entity.phase) {
      case 'inbox':
      case 'awaiting-pickup': {
        const slots = RECEPTION.conveyorSlots;
        const [x, y, z] = slots[Math.min(entity.slot, slots.length - 1)];
        // Overflow envelopes pile slightly above the last slot
        const overflow = Math.max(0, entity.slot - (slots.length - 1));
        target.set(x, y + overflow * 0.1, z);
        settled.current = false;
        break;
      }
      case 'in-review': {
        const [x, y, z] = QA_DESK.stackBase;
        target.set(x, y + entity.slot * 0.09, z);
        settled.current = false;
        break;
      }
      case 'carried': {
        const owner = entity.agentId
          ? useOfficeStore.getState().positions.get(entity.agentId)
          : undefined;
        if (deskPos && owner && Math.hypot(owner.x - deskPos[0], owner.z - deskPos[2]) < DESK_SETTLE_DIST) {
          // Owner is at the desk → envelope rests on the desktop
          target.set(deskPos[0] - 0.6, 0.86 + entity.slot * 0.09, deskPos[2] + 0.15);
          settled.current = true;
        } else if (owner) {
          // Follow the carrier at hand height, slightly ahead
          target.set(owner.x, CARRY_HEIGHT, owner.z);
          spin = false;
          settled.current = false;
        } else if (deskPos) {
          target.set(deskPos[0] - 0.6, 0.86 + entity.slot * 0.09, deskPos[2] + 0.15);
        }
        break;
      }
    }

    group.position.lerp(target, Math.min(1, delta * (settled.current ? 10 : 6)));
    if (spin) group.rotation.y += delta * 2;
  });

  return (
    <group ref={ref} position={RECEPTION.conveyorSlots[0]}>
      {/* Body */}
      <Box args={[0.46, 0.05, 0.3]} castShadow>
        <meshStandardMaterial color="#f8fafc" />
      </Box>
      {/* Flap lines */}
      <Box args={[0.46, 0.012, 0.02]} position={[0, 0.03, -0.07]} rotation={[0.4, 0, 0]}>
        <meshStandardMaterial color="#cbd5e1" />
      </Box>
      {/* Agent-color sticker (seal) */}
      <Box args={[0.1, 0.015, 0.1]} position={[0, 0.032, 0.04]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
      </Box>
    </group>
  );
}
