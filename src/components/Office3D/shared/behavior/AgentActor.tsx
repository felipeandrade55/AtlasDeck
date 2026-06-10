'use client';

/**
 * Environment-agnostic walking avatar. A generalization of the classic
 * MovingAvatar: instead of hardcoded desk/interest-point coordinates it
 * consumes an `EnvLayout`, so the same actor drives Mission Control,
 * the Startup Campus and any future environment.
 *
 * Target priority (first match wins):
 *   1. errand from the office store (envelope pickup)
 *   2. meeting seat (when the team convenes)
 *   3. own work anchor          — working / thinking / stuck
 *   4. visit anchor             — delegating / reviewing (orchestrator)
 *   5. offline parking spot
 *   6. idle: claimed POI (arcade, sofa, coffee…) or random wander
 *
 * Movement is constant-speed seek with an arrive ramp (the classic lerp
 * decelerated asymptotically and never visually "arrived"), plus a
 * tangential slide when blocked so avatars thread console rows instead
 * of teleport-rerolling.
 */
import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import VoxelAvatar from '../avatars/VoxelAvatar';
import type { AgentState } from '../../agentsConfig';
import type { OfficeAgent } from '../data/useOfficeData';
import type { Anchor, EnvLayout, PoseName } from './behaviorTypes';
import { useOfficeStore } from '../data/officeStore';

interface AgentActorProps {
  agent: OfficeAgent;
  state?: AgentState;
  layout: EnvLayout;
  /** Seat index at the environment's meeting spot, or null. */
  meetingSeatIndex: number | null;
  scale?: number;
}

const IDLE_STATE: AgentState = { id: '', status: 'idle' };
const ARRIVE_RADIUS = 0.25;
const MIN_DIST_OBSTACLE = 1.0;
const MIN_DIST_AVATAR = 1.2;

/** Short idle chatter shown while two agents share a POI ('talk' pose). */
const CHATTER = ['☕ bom café!', 'viu a missão?', 'haha 😄', 'GG!', 'deploy ok ✅', '🤖 bip bop', 'pausa rápida'];

/** Walk speed per status (world units/s). */
function speedFor(status: AgentState['status']): number {
  switch (status) {
    case 'idle': return 2.2;
    case 'delegating': return 2.6;
    case 'reviewing': return 2.2;
    case 'stuck':
    case 'offline': return 1.2;
    default: return 2.0;
  }
}

/** Idle reroll cadence per status (ms) — mirrors the classic getInterval. */
function rerollInterval(status: AgentState['status']): number {
  switch (status) {
    case 'idle': return 6000 + Math.random() * 5000;
    case 'working': return 12000 + Math.random() * 6000;
    case 'thinking': return 20000 + Math.random() * 10000;
    case 'delegating': return 7000 + Math.random() * 3000;
    case 'reviewing': return 30000;
    case 'stuck': return 60000;
    case 'offline': return 60000;
    default: return 10000;
  }
}

export default function AgentActor({
  agent,
  state: stateProp,
  layout,
  meetingSeatIndex,
  scale = 3,
}: AgentActorProps) {
  const state = stateProp ?? IDLE_STATE;
  const groupRef = useRef<Group>(null);
  const [pose, setPose] = useState<PoseName>('stand');
  const [heldProp, setHeldProp] = useState<'controller' | 'coffee' | null>(null);
  const [speech, setSpeech] = useState<string | null>(null);

  // Idle chatter while in 'talk' pose (e.g. sharing the coffee corner).
  // The bubble is gated on `pose === 'talk'` at render time, so leaving
  // the pose hides it without a state reset here.
  useEffect(() => {
    if (pose !== 'talk') return;
    const pick = () => setSpeech(CHATTER[Math.floor(Math.random() * CHATTER.length)]);
    const kickoff = setTimeout(pick, 150);
    const interval = setInterval(pick, 6000 + Math.random() * 3000);
    return () => {
      clearTimeout(kickoff);
      clearInterval(interval);
    };
  }, [pose]);

  const errand = useOfficeStore((s) => s.errands.get(agent.id));

  const anchors = useMemo(() => layout.agentAnchors(agent.id), [layout, agent.id]);

  // Target = where we're heading; anchor = what we do once we get there.
  const targetRef = useRef<{ pos: Vector3; anchor: Anchor | null; isErrand?: boolean } | null>(null);
  /** Seconds spent standing at an errand anchor (pickup dwell time). */
  const errandDwell = useRef(0);

  const isPositionFree = useCallback(
    (pos: Vector3, ignoreObstacles = false): boolean => {
      if (!ignoreObstacles) {
        for (const o of layout.obstacles) {
          const dx = pos.x - o.position[0];
          const dz = pos.z - o.position[2];
          if (Math.hypot(dx, dz) < o.radius + MIN_DIST_OBSTACLE) return false;
        }
      }
      for (const [otherId, otherPos] of useOfficeStore.getState().positions.entries()) {
        if (otherId === agent.id) continue;
        if (pos.distanceTo(otherPos) < MIN_DIST_AVATAR) return false;
      }
      return true;
    },
    [layout, agent.id],
  );

  // Spawn at a random free position inside bounds.
  const [initialPos] = useState(() => {
    const { bounds, walkY } = layout;
    let pos = new Vector3(0, walkY, 0);
    for (let i = 0; i < 50; i++) {
      const x = bounds.minX + 1 + Math.random() * (bounds.maxX - bounds.minX - 2);
      const z = bounds.minZ + 1 + Math.random() * (bounds.maxZ - bounds.minZ - 2);
      pos = new Vector3(x, walkY, z);
      let free = true;
      for (const o of layout.obstacles) {
        if (Math.hypot(x - o.position[0], z - o.position[2]) < o.radius + MIN_DIST_OBSTACLE) {
          free = false;
          break;
        }
      }
      if (free) break;
    }
    return pos;
  });
  const currentPos = useRef(initialPos.clone());
  const yawRef = useRef(0);

  // Publish position to the transient store; clean up on unmount.
  useEffect(() => {
    const store = useOfficeStore.getState();
    store.writePosition(agent.id, currentPos.current);
    return () => {
      store.removePosition(agent.id);
      store.releasePoi(agent.id);
    };
  }, [agent.id]);

  /** Pick a wander/POI target for the idle state. */
  const pickIdleTarget = useCallback((): { pos: Vector3; anchor: Anchor | null } => {
    const store = useOfficeStore.getState();
    const { bounds, walkY, idlePOIs } = layout;

    // Weighted POI pick (claims a slot; full POIs fall through to wander)
    const totalWeight = idlePOIs.reduce((a, p) => a + p.weight, 0);
    if (totalWeight > 0 && Math.random() < Math.min(0.85, totalWeight)) {
      const r = Math.random() * totalWeight;
      let acc = 0;
      for (const poi of idlePOIs) {
        acc += poi.weight;
        if (r < acc) {
          store.releasePoi(agent.id);
          const slot = store.claimPoi(poi.id, agent.id, poi.capacity);
          if (slot !== null) {
            const anchor = slot === 0 ? poi.anchor : poi.extraAnchors?.[slot - 1] ?? poi.anchor;
            return { pos: new Vector3(...anchor.position), anchor };
          }
          break;
        }
      }
    }

    // Plain wander
    store.releasePoi(agent.id);
    for (let i = 0; i < 20; i++) {
      const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
      const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
      const pos = new Vector3(x, walkY, z);
      if (isPositionFree(pos)) return { pos, anchor: null };
    }
    return { pos: currentPos.current.clone(), anchor: null };
  }, [layout, agent.id, isPositionFree]);

  /** Resolve the current target by behavior priority. */
  const resolveTarget = useCallback((): { pos: Vector3; anchor: Anchor | null; isErrand?: boolean } => {
    const store = useOfficeStore.getState();
    if (errand) {
      return { pos: new Vector3(...errand.anchor.position), anchor: errand.anchor, isErrand: true };
    }
    if (meetingSeatIndex !== null) {
      const seat = anchors.meetingSeat(meetingSeatIndex);
      store.releasePoi(agent.id);
      return { pos: new Vector3(...seat.position), anchor: seat };
    }
    const status = state.status;
    if (status === 'working' || status === 'thinking' || status === 'stuck') {
      store.releasePoi(agent.id);
      return { pos: new Vector3(...anchors.work.position), anchor: anchors.work };
    }
    if ((status === 'delegating' || status === 'reviewing') && state.focusAgentId) {
      store.releasePoi(agent.id);
      const visit = anchors.visit(state.focusAgentId, status === 'reviewing');
      return { pos: new Vector3(...visit.position), anchor: visit };
    }
    if (status === 'offline') {
      store.releasePoi(agent.id);
      return { pos: new Vector3(...anchors.offline.position), anchor: anchors.offline };
    }
    return pickIdleTarget();
  }, [errand, meetingSeatIndex, anchors, state.status, state.focusAgentId, agent.id, pickIdleTarget]);

  // Re-target when behavior inputs change + reroll cadence for idle drift.
  const focusKey = state.focusAgentId ?? '';
  useEffect(() => {
    targetRef.current = resolveTarget();
    if (state.status !== 'idle' || errand || meetingSeatIndex !== null) return;
    const interval = setInterval(() => {
      targetRef.current = resolveTarget();
    }, rerollInterval(state.status));
    return () => clearInterval(interval);
    // resolveTarget identity covers layout/anchors/errand changes
  }, [state.status, focusKey, meetingSeatIndex, errand, resolveTarget]);

  const blockedFrames = useRef(0);

  useFrame((_, delta) => {
    const group = groupRef.current;
    const target = targetRef.current;
    if (!group || !target) return;

    const toTarget = new Vector3().subVectors(target.pos, currentPos.current);
    const dist = toTarget.length();
    const anchored = target.anchor !== null;

    if (dist > ARRIVE_RADIUS) {
      // --- Walking: constant-speed seek with arrive ramp ---
      const speed = speedFor(state.status) * Math.min(1, Math.max(0.35, dist / 0.8));
      const step = Math.min(speed * delta, dist);
      const dir = toTarget.clone().normalize();
      let next = currentPos.current.clone().addScaledVector(dir, step);

      // Near an anchor furniture is expected to be close — drop the
      // obstacle gate so the avatar can actually reach its seat.
      const relaxObstacles = anchored && dist < 2.2;
      if (!isPositionFree(next, relaxObstacles)) {
        // Tangential slide: try stepping diagonally around the blocker.
        const perp = new Vector3(dir.z, 0, -dir.x);
        const slideA = currentPos.current.clone().addScaledVector(perp, step).addScaledVector(dir, step * 0.3);
        const slideB = currentPos.current.clone().addScaledVector(perp, -step).addScaledVector(dir, step * 0.3);
        if (isPositionFree(slideA, relaxObstacles)) next = slideA;
        else if (isPositionFree(slideB, relaxObstacles)) next = slideB;
        else {
          blockedFrames.current += 1;
          // Persistently stuck on a wander → pick another destination.
          if (blockedFrames.current > 40 && !anchored) {
            targetRef.current = pickIdleTarget();
            blockedFrames.current = 0;
          }
          return;
        }
      }
      blockedFrames.current = 0;
      errandDwell.current = 0;
      currentPos.current.copy(next);
      group.position.copy(currentPos.current);
      useOfficeStore.getState().writePosition(agent.id, currentPos.current);

      // Face the walking direction (smoothed)
      const targetYaw = Math.atan2(dir.x, dir.z);
      yawRef.current += shortestAngle(yawRef.current, targetYaw) * Math.min(1, delta * 10);
      group.rotation.y = yawRef.current;
      const walkPose: PoseName = target.anchor?.prop === 'envelope' ? 'carry' : 'walk';
      if (pose !== walkPose) setPose(walkPose);
      if (heldProp !== null) setHeldProp(null);
    } else {
      // --- Arrived ---
      if (anchored) {
        // Snap softly onto the anchor and settle into its yaw/pose.
        currentPos.current.lerp(target.pos, Math.min(1, delta * 8));
        group.position.copy(currentPos.current);
        useOfficeStore.getState().writePosition(agent.id, currentPos.current);
        const anchorYaw = target.anchor!.yaw;
        yawRef.current += shortestAngle(yawRef.current, anchorYaw) * Math.min(1, delta * 8);
        group.rotation.y = yawRef.current;
        if (pose !== target.anchor!.pose) setPose(target.anchor!.pose);
        const prop = target.anchor!.prop;
        const held = prop === 'controller' || prop === 'coffee' ? prop : null;
        if (heldProp !== held) setHeldProp(held);

        // Errand fulfilled: dwell briefly at the pickup spot, then clear it
        // so the envelope latches onto this agent and normal behavior
        // (walk back to the desk) resumes.
        if (target.isErrand) {
          errandDwell.current += delta;
          if (errandDwell.current > 0.7) {
            errandDwell.current = 0;
            useOfficeStore.getState().setErrand(agent.id, null);
          }
        }
      } else {
        if (pose !== 'stand') setPose('stand');
        if (heldProp !== null) setHeldProp(null);
      }
    }
  });

  return (
    <group ref={groupRef} position={initialPos} scale={scale}>
      <VoxelAvatar
        agent={agent}
        pose={pose}
        mood={state.status === 'stuck' ? 'error' : 'neutral'}
        thinking={state.status === 'thinking' || state.status === 'reviewing'}
        heldProp={heldProp}
        speechBubble={pose === 'talk' ? speech : null}
      />
    </group>
  );
}

/** Signed shortest rotation from `from` to `to` (radians). */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
