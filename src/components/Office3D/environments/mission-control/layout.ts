/**
 * Mission Control HQ — spatial layout. A NASA-style control room:
 *
 *   - giant videowall on the back wall (z = -ROOM.depth/2)
 *   - specialist consoles in rows facing the videowall
 *   - Jarvis podium (raised platform) behind the rows
 *   - glass war room on the right, lounge on the left
 *
 * Everything here is pure data derived from the roster; AgentActor and the
 * scene components consume it. Coordinates: +x right, +z toward the camera.
 */
import type { OfficeAgent } from '../../shared/data/useOfficeData';
import type { Anchor, EnvLayout, Obstacle, IdlePoi } from '../../shared/behavior/behaviorTypes';

export const ROOM = { width: 26, depth: 19, height: 7.5 };
export const WALK_Y = 0.6;

/**
 * Root heights for seated avatars (scale-3 voxel skeleton: the butt lands
 * 0.39 world units below the root when the sit pose lowers the hips):
 * chair seat-top 0.88 → 1.27; podium chair on the 0.5 platform → 1.77;
 * sofa cushion ~0.67 → 1.06.
 */
export const SIT_CHAIR_Y = 1.27;
export const SIT_PODIUM_Y = 1.77;
export const SIT_SOFA_Y = 1.06;

export const VIDEOWALL = {
  center: [0, 3.4, -9.2] as [number, number, number],
  width: 14,
  height: 4.8,
};

export const PODIUM = {
  center: [0, 0, 6.8] as [number, number, number],
  size: [3.6, 0.5, 2.8] as [number, number, number],
};

export const WAR_ROOM = {
  center: [9.2, 0, -4.2] as [number, number, number],
  size: [6.2, 5.4] as [number, number], // x, z footprint
  tableSize: [2.8, 1.4] as [number, number],
};

export const LOUNGE = {
  center: [-9.5, 0, 4.5] as [number, number, number],
};

const CONSOLE_ROW_Z = [-3.4, -0.4, 2.6];
const CONSOLE_SPACING = 3.2;
const CONSOLES_PER_ROW = 4;

export interface ConsoleSlot {
  agentId: string;
  position: [number, number, number];
}

/** War-room seats around the table, head seat (index 0) on the far side. */
export const WAR_SEATS: Array<[number, number]> = [
  [WAR_ROOM.center[0] + 2.2, WAR_ROOM.center[2]],
  [WAR_ROOM.center[0] - 1.0, WAR_ROOM.center[2] - 1.5],
  [WAR_ROOM.center[0] + 0.6, WAR_ROOM.center[2] - 1.5],
  [WAR_ROOM.center[0] - 1.0, WAR_ROOM.center[2] + 1.5],
  [WAR_ROOM.center[0] + 0.6, WAR_ROOM.center[2] + 1.5],
  [WAR_ROOM.center[0] - 2.2, WAR_ROOM.center[2]],
];

function yawTowards(from: [number, number], to: [number, number]): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

export interface MissionControlLayout {
  layout: EnvLayout;
  consoles: ConsoleSlot[];
}

export function buildMissionControlLayout(agents: OfficeAgent[]): MissionControlLayout {
  const specialists = agents.filter((a) => a.id !== 'main' && a.id !== 'jarvis');

  // Console grid: rows fill front-to-back, centered per row.
  const consoles: ConsoleSlot[] = specialists.map((a, idx) => {
    const row = Math.floor(idx / CONSOLES_PER_ROW);
    const inRow = idx % CONSOLES_PER_ROW;
    const rowCount = Math.min(CONSOLES_PER_ROW, specialists.length - row * CONSOLES_PER_ROW);
    const x = (inRow - (rowCount - 1) / 2) * CONSOLE_SPACING;
    const z = CONSOLE_ROW_Z[Math.min(row, CONSOLE_ROW_Z.length - 1)];
    return { agentId: a.id, position: [x, 0, z] };
  });
  const consoleById = new Map(consoles.map((c) => [c.agentId, c]));

  const obstacles: Obstacle[] = [
    ...consoles.map((c): Obstacle => ({ position: c.position, radius: 1.0 })),
    { position: PODIUM.center, radius: 2.3 },
    { position: WAR_ROOM.center, radius: 1.9 }, // war table — seats reach via relaxed gate
    { position: [11.8, 0, 5.2], radius: 0.6 },  // coffee machine
    { position: [-12.2, 0, -8.2], radius: 0.5 }, // plant
    { position: [12.2, 0, -8.2], radius: 0.5 },  // plant
    { position: [-12.3, 0, 4.5], radius: 0.8 },  // lounge TV
    { position: [-8.6, 0, 4.5], radius: 1.2 },   // sofa
    { position: [-12.35, 0, 7.6], radius: 0.7 }, // arcade cabinet
  ];

  const idlePOIs: IdlePoi[] = [
    {
      // Sofa: seat 0 plays the games console on the TV, the others watch.
      id: 'sofa',
      weight: 0.35,
      capacity: 3,
      anchor: { position: [-8.75, SIT_SOFA_Y, 4.5], yaw: -Math.PI / 2, pose: 'sit-gaming', prop: 'controller' },
      extraAnchors: [
        { position: [-8.75, SIT_SOFA_Y, 3.5], yaw: -Math.PI / 2, pose: 'sit' },
        { position: [-8.75, SIT_SOFA_Y, 5.5], yaw: -Math.PI / 2, pose: 'sit' },
      ],
    },
    {
      id: 'arcade',
      weight: 0.2,
      capacity: 1,
      anchor: { position: [-11.35, WALK_Y, 7.6], yaw: -Math.PI / 2, pose: 'arcade' },
    },
    {
      id: 'coffee',
      weight: 0.25,
      capacity: 2,
      anchor: { position: [10.9, WALK_Y, 5.2], yaw: Math.PI / 2, pose: 'stand', prop: 'coffee' },
      extraAnchors: [{ position: [10.7, WALK_Y, 6.2], yaw: Math.PI / 2, pose: 'talk', prop: 'coffee' }],
    },
    {
      id: 'videowall-gaze',
      weight: 0.1,
      capacity: 3,
      anchor: { position: [-6.5, WALK_Y, -6.2], yaw: Math.PI, pose: 'stand' },
      extraAnchors: [
        { position: [-5.2, WALK_Y, -6.4], yaw: Math.PI, pose: 'stand' },
        { position: [6.0, WALK_Y, -6.2], yaw: Math.PI, pose: 'stand' },
      ],
    },
  ];

  const offlineCorner: [number, number] = [-11.8, 8.2];

  const layout: EnvLayout = {
    bounds: { minX: -12, maxX: 12, minZ: -7.4, maxZ: 8.6 },
    walkY: WALK_Y,
    obstacles,
    idlePOIs,
    agentAnchors(agentId: string) {
      const isMain = agentId === 'main' || agentId === 'jarvis';
      const console_ = consoleById.get(agentId);
      const specialistIdx = specialists.findIndex((a) => a.id === agentId);

      // Where this agent works: their console seat, or the podium for main.
      const work: Anchor = isMain
        ? {
            position: [PODIUM.center[0], SIT_PODIUM_Y, PODIUM.center[2] + 0.45],
            yaw: Math.PI,
            pose: 'sit-typing',
          }
        : console_
          ? {
              position: [console_.position[0], SIT_CHAIR_Y, console_.position[2] + 1.1],
              yaw: Math.PI,
              pose: 'sit-typing',
            }
          : { position: [0, WALK_Y, 5], yaw: Math.PI, pose: 'stand' };

      return {
        work,
        visit(targetAgentId: string, reviewing: boolean): Anchor {
          const target = consoleById.get(targetAgentId);
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
            yaw: yawTowards(seat, [WAR_ROOM.center[0], WAR_ROOM.center[2]]),
            pose: 'sit',
          };
        },
        offline: {
          position: [
            offlineCorner[0] + (specialistIdx >= 0 ? specialistIdx : specialists.length) * 1.3,
            WALK_Y,
            offlineCorner[1],
          ],
          yaw: 0,
          pose: 'stand',
        },
      };
    },
  };

  return { layout, consoles };
}
