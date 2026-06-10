/**
 * Pose system for the voxel avatar, split in two layers so the component
 * stays small:
 *
 *   - `setStatic` places the skeleton for a pose (applied once on pose
 *     change): hip height, leg/arm base rotations.
 *   - `animate` runs every frame and SETS absolute rotations derived from
 *     the static base + an oscillation, so values never drift.
 */
import type { Group } from 'three';
import type { PoseName } from '../behavior/behaviorTypes';

export interface AvatarRefs {
  root: Group;
  hips: Group;
  head: Group;
  leftArm: Group;
  rightArm: Group;
  leftLeg: Group;
  rightLeg: Group;
}

interface PoseDef {
  /** Hip-group vertical offset (sitting lowers the body). */
  hipsY: number;
  /** Base rotation.x for both legs (−π/2 = legs forward = seated). */
  legRotX: number;
  /** Base rotation.x for [left, right] arms. */
  armRotX: [number, number];
  /** Per-frame oscillation on top of the base. */
  animate?: (r: AvatarRefs, t: number, base: PoseDef) => void;
}

const POSES: Record<PoseName, PoseDef> = {
  stand: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [0, 0],
    animate(r, t) {
      // subtle breathing
      r.hips.position.y = Math.sin(t * 1.4) * 0.008;
    },
  },
  walk: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [0, 0],
    animate(r, t) {
      const swing = Math.sin(t * 9);
      r.leftLeg.rotation.x = swing * 0.55;
      r.rightLeg.rotation.x = -swing * 0.55;
      r.leftArm.rotation.x = -swing * 0.45;
      r.rightArm.rotation.x = swing * 0.45;
      r.hips.position.y = Math.abs(Math.cos(t * 9)) * 0.02;
    },
  },
  sit: {
    hipsY: -0.13,
    legRotX: -Math.PI / 2,
    armRotX: [-0.25, -0.25],
    animate(r, t) {
      r.hips.position.y = -0.13 + Math.sin(t * 1.4) * 0.006;
      r.head.rotation.y = Math.sin(t * 0.6) * 0.18;
    },
  },
  'sit-typing': {
    hipsY: -0.13,
    legRotX: -Math.PI / 2,
    armRotX: [-0.85, -0.85],
    animate(r, t) {
      r.leftArm.rotation.x = -0.85 + Math.sin(t * 7) * 0.18;
      r.rightArm.rotation.x = -0.85 + Math.sin(t * 7 + Math.PI) * 0.18;
    },
  },
  'sit-gaming': {
    hipsY: -0.13,
    legRotX: -Math.PI / 2,
    armRotX: [-1.05, -1.05],
    animate(r, t) {
      // thumb-mash jitter + leaning into the game
      const jitter = Math.sin(t * 16) * 0.05;
      r.leftArm.rotation.x = -1.05 + jitter;
      r.rightArm.rotation.x = -1.05 - jitter;
      r.hips.rotation.x = 0.06 + Math.sin(t * 2.2) * 0.02;
    },
  },
  arcade: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [-1.0, -1.0],
    animate(r, t) {
      // joystick mashing while standing at the cabinet
      const jitter = Math.sin(t * 14) * 0.07;
      r.leftArm.rotation.x = -1.0 + jitter;
      r.rightArm.rotation.x = -1.0 - jitter;
      r.hips.position.y = Math.abs(Math.sin(t * 6)) * 0.012;
    },
  },
  carry: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [-1.25, -1.25],
    animate(r, t) {
      const swing = Math.sin(t * 9);
      r.leftLeg.rotation.x = swing * 0.45;
      r.rightLeg.rotation.x = -swing * 0.45;
      r.hips.position.y = Math.abs(Math.cos(t * 9)) * 0.018;
    },
  },
  celebrate: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [Math.PI - 0.4, Math.PI - 0.4],
    animate(r, t) {
      r.hips.position.y = Math.abs(Math.sin(t * 5)) * 0.06;
      r.leftArm.rotation.z = Math.sin(t * 5) * 0.25;
      r.rightArm.rotation.z = -Math.sin(t * 5) * 0.25;
    },
  },
  talk: {
    hipsY: 0,
    legRotX: 0,
    armRotX: [0, -0.5],
    animate(r, t) {
      r.head.position.y = 0.35 + Math.sin(t * 4) * 0.012;
      r.rightArm.rotation.x = -0.5 + Math.sin(t * 3.2) * 0.2;
      r.rightArm.rotation.z = -0.2 + Math.sin(t * 2.1) * 0.12;
    },
  },
};

/** Reset every animated channel to the pose's static base. */
export function applyStaticPose(r: AvatarRefs, pose: PoseName): void {
  const def = POSES[pose];
  r.hips.position.y = def.hipsY;
  r.hips.rotation.x = 0;
  r.head.position.y = 0.35;
  r.head.rotation.set(0, 0, 0);
  r.leftLeg.rotation.set(def.legRotX, 0, 0);
  r.rightLeg.rotation.set(def.legRotX, 0, 0);
  r.leftArm.rotation.set(def.armRotX[0], 0, 0);
  r.rightArm.rotation.set(def.armRotX[1], 0, 0);
}

/** Per-frame oscillation for the active pose. */
export function animatePose(r: AvatarRefs, pose: PoseName, t: number): void {
  POSES[pose].animate?.(r, t, POSES[pose]);
}
