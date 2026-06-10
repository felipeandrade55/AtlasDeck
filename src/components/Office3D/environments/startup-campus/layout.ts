/**
 * Startup Campus — spatial layout. The task pipeline as physical space:
 *
 *   - reception + envelope conveyor on the front-right (new tasks arrive)
 *   - open space with notebook desks in the middle (work happens)
 *   - war room with a telão on the back-left (meetings)
 *   - QA desk for the orchestrator at the back (review queue = paper stack)
 *   - Done wall above/behind QA (approved deliveries framed)
 *   - lounge on the right (sofa + TV + coffee bar)
 *
 * Coordinates: +x right, +z toward the camera. Room 26 × 20.
 */
import type { OfficeAgent } from '../../shared/data/useOfficeData';
import type { Anchor, EnvLayout, Obstacle, IdlePoi } from '../../shared/behavior/behaviorTypes';

export const ROOM = { width: 26, depth: 20, height: 6.5 };
export const WALK_Y = 0.6;

/** Seated root heights (see mission-control/layout.ts for the math). */
export const SIT_CHAIR_Y = 1.27;
export const SIT_SOFA_Y = 1.06;

export const RECEPTION = {
  counter: [8.5, 0, 7.8] as [number, number, number],
  counterSize: [3.6, 1.05, 0.9] as [number, number, number],
  /** Conveyor belt behind the counter, along the front wall. */
  beltY: 1.06,
  beltZ: 9.0,
  conveyorSlots: [6.8, 7.7, 8.6, 9.5, 10.4].map((x) => [x, 1.12, 9.0] as [number, number, number]),
  /** Where an agent stands to pick an envelope up. */
  pickup: [8.5, WALK_Y, 6.4] as [number, number, number],
};

export const QA_DESK = {
  center: [5.5, 0, -7.0] as [number, number, number],
  /** Where review envelopes stack up. */
  stackBase: [6.3, 0.86, -7.0] as [number, number, number],
};

export const WAR_ZONE = {
  tableCenter: [-8.5, 0, -6.3] as [number, number, number],
  tableSize: [3.0, 1.6] as [number, number],
  /** Telão on the back wall behind the table. */
  screenCenter: [-8.5, 2.6, -9.7] as [number, number, number],
};

export const DONE_WALL = {
  center: [3.5, 2.9, -9.78] as [number, number, number],
  cols: 4,
  rows: 2,
  spacing: [1.7, 1.35] as [number, number],
};

const WAR_SEATS: Array<[number, number]> = [
  [-6.5, -6.3],
  [-9.3, -7.4],
  [-8.0, -7.4],
  [-9.3, -5.2],
  [-8.0, -5.2],
  [-10.5, -6.3],
];

/** Open-space desk grid: 4 per row, facing -z (notebook toward the agent). */
const DESK_ROW_Z = [-2.2, 1.6, 5.0];
const DESK_SPACING = 3.3;
const DESKS_PER_ROW = 4;
const DESK_X_OFFSET = -5.0; // shift the cluster left of center

export interface DeskSlot {
  agentId: string;
  position: [number, number, number];
}

function yawTowards(from: [number, number], to: [number, number]): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

export interface StartupCampusLayout {
  layout: EnvLayout;
  desks: DeskSlot[];
}

export function buildStartupCampusLayout(agents: OfficeAgent[]): StartupCampusLayout {
  const specialists = agents.filter((a) => a.id !== 'main' && a.id !== 'jarvis');

  const desks: DeskSlot[] = specialists.map((a, idx) => {
    const row = Math.floor(idx / DESKS_PER_ROW);
    const inRow = idx % DESKS_PER_ROW;
    const rowCount = Math.min(DESKS_PER_ROW, specialists.length - row * DESKS_PER_ROW);
    const x = DESK_X_OFFSET + (inRow - (rowCount - 1) / 2) * DESK_SPACING;
    const z = DESK_ROW_Z[Math.min(row, DESK_ROW_Z.length - 1)];
    return { agentId: a.id, position: [x, 0, z] };
  });
  const deskById = new Map(desks.map((d) => [d.agentId, d]));

  const obstacles: Obstacle[] = [
    ...desks.map((d): Obstacle => ({ position: d.position, radius: 1.0 })),
    { position: RECEPTION.counter, radius: 1.6 },
    { position: QA_DESK.center, radius: 1.3 },
    { position: WAR_ZONE.tableCenter, radius: 1.9 },
    { position: [12.4, 0, 0.2], radius: 0.8 },  // lounge TV (right wall)
    { position: [9.6, 0, 0.2], radius: 1.2 },   // sofa
    { position: [12.2, 0, 3.6], radius: 0.6 },  // coffee machine
    { position: [-12.2, 0, 8.2], radius: 0.5 }, // plant
    { position: [-12.2, 0, -8.6], radius: 0.5 }, // plant
  ];

  const idlePOIs: IdlePoi[] = [
    {
      id: 'campus-sofa',
      weight: 0.35,
      capacity: 3,
      anchor: { position: [9.75, SIT_SOFA_Y, 0.2], yaw: Math.PI / 2, pose: 'sit-gaming', prop: 'controller' },
      extraAnchors: [
        { position: [9.75, SIT_SOFA_Y, -0.8], yaw: Math.PI / 2, pose: 'sit' },
        { position: [9.75, SIT_SOFA_Y, 1.2], yaw: Math.PI / 2, pose: 'sit' },
      ],
    },
    {
      id: 'campus-coffee',
      weight: 0.3,
      capacity: 2,
      anchor: { position: [11.3, WALK_Y, 3.6], yaw: Math.PI / 2, pose: 'talk', prop: 'coffee' },
      extraAnchors: [{ position: [11.1, WALK_Y, 4.6], yaw: Math.PI / 2, pose: 'talk', prop: 'coffee' }],
    },
    {
      id: 'done-wall-gaze',
      weight: 0.12,
      capacity: 2,
      anchor: { position: [3.0, WALK_Y, -8.0], yaw: Math.PI, pose: 'stand' },
      extraAnchors: [{ position: [4.4, WALK_Y, -8.0], yaw: Math.PI, pose: 'stand' }],
    },
  ];

  const offlineCorner: [number, number] = [-12.0, 8.4];

  const layout: EnvLayout = {
    bounds: { minX: -12, maxX: 12, minZ: -8.4, maxZ: 8.4 },
    walkY: WALK_Y,
    obstacles,
    idlePOIs,
    pickupAnchor: { position: RECEPTION.pickup, yaw: 0, pose: 'stand', prop: 'envelope' },
    agentAnchors(agentId: string) {
      const isMain = agentId === 'main' || agentId === 'jarvis';
      const desk = deskById.get(agentId);
      const specialistIdx = specialists.findIndex((a) => a.id === agentId);

      // Jarvis works at the QA desk facing the room (+z); specialists sit
      // behind their open-space desk facing the back wall (-z).
      const work: Anchor = isMain
        ? {
            position: [QA_DESK.center[0], SIT_CHAIR_Y, QA_DESK.center[2] - 1.1],
            yaw: 0,
            pose: 'sit-typing',
          }
        : desk
          ? {
              position: [desk.position[0], SIT_CHAIR_Y, desk.position[2] + 1.1],
              yaw: Math.PI,
              pose: 'sit-typing',
            }
          : { position: [0, WALK_Y, 4], yaw: Math.PI, pose: 'stand' };

      return {
        work,
        visit(targetAgentId: string, reviewing: boolean): Anchor {
          const target = deskById.get(targetAgentId);
          if (!target) return work;
          const side = reviewing ? 1.7 : 1.4;
          const standAt: [number, number] = [target.position[0] - side, target.position[2] + 0.9];
          const seatAt: [number, number] = [target.position[0], target.position[2] + 1.1];
          return {
            position: [standAt[0], WALK_Y, standAt[1]],
            yaw: yawTowards(standAt, seatAt),
            pose: 'stand',
          };
        },
        meetingSeat(index: number): Anchor {
          const seat = WAR_SEATS[index % WAR_SEATS.length];
          return {
            position: [seat[0], SIT_CHAIR_Y, seat[1]],
            yaw: yawTowards(seat, [WAR_ZONE.tableCenter[0], WAR_ZONE.tableCenter[2]]),
            pose: 'sit',
          };
        },
        offline: {
          position: [
            offlineCorner[0] + (specialistIdx >= 0 ? specialistIdx : specialists.length) * 1.3,
            WALK_Y,
            offlineCorner[1],
          ],
          yaw: Math.PI,
          pose: 'stand',
        },
      };
    },
  };

  return { layout, desks };
}
