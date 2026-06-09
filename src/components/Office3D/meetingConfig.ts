/**
 * Meeting room config — shared between MeetingTable (renders the table +
 * chairs) and Office3D (decides who convenes and seats them) and
 * MovingAvatar (walks the avatar to its seat).
 *
 * The table sits in the open area in front of the whiteboard (between the
 * desks and the back wall), so a meeting reads as "the team gathered at the
 * front of the room".
 */

export const MEETING_TABLE_CENTER: [number, number, number] = [0, 0, -5];

// Tabletop dimensions (x = width, z = depth) and top height.
export const MEETING_TABLE_SIZE = { width: 4.4, depth: 2.2, height: 1.0 };

// Y plane the walking avatars live on (matches MovingAvatar's initialPos.y).
export const SEAT_Y = 0.6;

/**
 * Seat positions = where an avatar stands/sits, just outside the tabletop
 * edge. Seat 0 is a head seat reserved for the orchestrator (Jarvis/main);
 * the rest fill in as specialists join the meeting.
 */
export const MEETING_SEATS: [number, number, number][] = [
  [2.9, SEAT_Y, -5.0], // 0 — cabeceira (orquestrador)
  [-1.6, SEAT_Y, -6.7], // 1 — fundo esquerda
  [0.0, SEAT_Y, -6.7], // 2 — fundo centro
  [1.6, SEAT_Y, -6.7], // 3 — fundo direita
  [-1.6, SEAT_Y, -3.3], // 4 — frente esquerda
  [0.0, SEAT_Y, -3.3], // 5 — frente centro
  [1.6, SEAT_Y, -3.3], // 6 — frente direita
  [-2.9, SEAT_Y, -5.0], // 7 — cabeceira oposta
];

// Minimum simultaneously-active specialists for a meeting to convene. Below
// this, everyone works at their own desk / wanders.
export const MEETING_MIN_PARTICIPANTS = 2;

/** Y-rotation so an object at `pos` faces the table center (around Y axis). */
export function facingTableY(pos: [number, number, number]): number {
  const dx = MEETING_TABLE_CENTER[0] - pos[0];
  const dz = MEETING_TABLE_CENTER[2] - pos[2];
  return Math.atan2(dx, dz);
}
