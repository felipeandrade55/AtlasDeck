/**
 * Environment-agnostic behavior contracts. Each 3D environment (Mission
 * Control, Startup Campus, …) describes itself as an `EnvLayout`; the
 * shared `AgentActor` consumes that description to decide where each
 * avatar walks, sits and what pose it strikes — no environment-specific
 * logic ever lives inside the actor.
 */
/** Poses the voxel avatar knows how to strike/animate. */
export type PoseName =
  | 'stand'
  | 'walk'
  | 'sit'
  | 'sit-typing'
  | 'sit-gaming'
  | 'arcade'
  | 'carry'
  | 'celebrate'
  | 'talk';

/** A spot an avatar can occupy: position + final orientation + pose. */
export interface Anchor {
  position: [number, number, number];
  /** Y rotation the avatar settles into once it arrives. */
  yaw: number;
  pose: PoseName;
  /** Optional prop held while in this anchor (rendered by the scene). */
  prop?: 'controller' | 'envelope' | 'coffee';
}

export interface Obstacle {
  position: [number, number, number];
  radius: number;
}

/** A leisure spot idle agents gravitate to (arcade, sofa, coffee bar…). */
export interface IdlePoi {
  id: string;
  anchor: Anchor;
  /** Relative probability of being picked over plain wandering. */
  weight: number;
  /** How many avatars fit here at once (arcade = 1, sofa = 3…). */
  capacity: number;
  /**
   * Extra anchors for the 2nd..Nth occupant (e.g. three sofa seats).
   * Index 0 implicitly equals `anchor`.
   */
  extraAnchors?: Anchor[];
}

/** One-off task an avatar must run before resuming normal behavior. */
export interface Errand {
  kind: 'pickup';
  taskId: string;
  anchor: Anchor;
}

export interface AgentAnchors {
  /** Where this agent works (console / desk seat). */
  work: Anchor;
  /** Where the orchestrator parks when visiting `targetAgentId`. */
  visit(targetAgentId: string, reviewing: boolean): Anchor;
  /** Seat `index` at this environment's meeting spot. */
  meetingSeat(index: number): Anchor;
  /** Where this agent parks while offline. */
  offline: Anchor;
}

/**
 * Full spatial description of an environment. Built from the live roster
 * (so anchors per agent already exist), consumed by AgentActor every frame.
 */
export interface EnvLayout {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Y plane walking avatars live on (0.6 in the classic scene). */
  walkY: number;
  obstacles: Obstacle[];
  agentAnchors(agentId: string): AgentAnchors;
  idlePOIs: IdlePoi[];
  /** Where envelopes are picked up (Startup Campus only). */
  pickupAnchor?: Anchor;
}
