/**
 * Compat layer for the two on-disk shapes of OpenClaw's agent registry.
 *
 *  - Legacy (OpenClaw <= 2026.8.x):   agents.list    = [{ id, name, model, ... }]
 *  - Current (OpenClaw >= 2026.9.5):  agents.entries = { [id]: { name, model, ... } }
 *                                     (+ agents.ownership = "explicit")
 *
 * OpenClaw >= 2026.9.5 rejects `agents.list` ("agents.list moved to keyed
 * agents.entries") and refuses to start, so AtlasDeck must never write it back
 * into a config that already uses `entries`.
 *
 * AtlasDeck code historically reads and mutates `config.agents.list` in many
 * places. Instead of rewriting every call site, we normalise at the I/O
 * boundary:
 *
 *  - after parsing openclaw.json → `expandAgentEntries(config)` adds an
 *    in-memory `agents.list` array built from `agents.entries`;
 *  - when writing openclaw.json → `serializeOpenClawConfig(config)` converts
 *    `agents.list` back into `agents.entries` (on a clone) whenever the config
 *    is in the current format.
 */

type AnyRecord = Record<string, any>;

function isPlainObject(v: unknown): v is AnyRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True when the config uses the keyed `agents.entries` format. */
export function usesAgentEntries(config: unknown): boolean {
  if (!isPlainObject(config) || !isPlainObject(config.agents)) return false;
  return isPlainObject(config.agents.entries) || config.agents.ownership !== undefined;
}

/** `agents.entries` → `[{ id, ...entry }]`, preserving key order. */
export function agentEntriesToList(entries: unknown): AnyRecord[] {
  if (!isPlainObject(entries)) return [];
  return Object.entries(entries).map(([id, entry]) => ({
    ...(isPlainObject(entry) ? entry : {}),
    id,
  }));
}

/** `[{ id, ...agent }]` → `{ [id]: agent }` (the `id` field becomes the key). */
export function agentListToEntries(list: unknown): AnyRecord {
  const out: AnyRecord = {};
  if (!Array.isArray(list)) return out;
  for (const agent of list) {
    if (!isPlainObject(agent) || typeof agent.id !== "string" || !agent.id) continue;
    const { id, ...rest } = agent;
    out[id] = rest;
  }
  return out;
}

/**
 * Mutates `config` so `config.agents.list` is always available as an array
 * when the file uses `agents.entries`. `entries` is kept in memory (never read
 * by AtlasDeck) so `serializeOpenClawConfig` knows to write the keyed format.
 * Returns the same object for chaining.
 */
export function expandAgentEntries<T>(config: T): T {
  const c = config as AnyRecord;
  if (!isPlainObject(c) || !isPlainObject(c.agents)) return config;
  if (isPlainObject(c.agents.entries) && !Array.isArray(c.agents.list)) {
    c.agents.list = agentEntriesToList(c.agents.entries);
  }
  return config;
}

/** Returns the agents array regardless of on-disk format (read-only use). */
export function getAgentList(config: unknown): AnyRecord[] {
  if (!isPlainObject(config) || !isPlainObject(config.agents)) return [];
  if (Array.isArray(config.agents.list)) return config.agents.list;
  return agentEntriesToList(config.agents.entries);
}

/**
 * Returns a copy of `config` ready to be written to openclaw.json: in the
 * current format, `agents.list` is folded into `agents.entries` and removed.
 * Legacy-format configs are returned unchanged. Never mutates the input.
 */
export function toOpenClawDiskShape<T>(config: T): T {
  const c = config as AnyRecord;
  if (!usesAgentEntries(c)) return config;
  const agents: AnyRecord = { ...c.agents };
  if (Array.isArray(agents.list)) {
    agents.entries = agentListToEntries(agents.list);
  }
  delete agents.list;
  return { ...c, agents } as T;
}

/** JSON.stringify for openclaw.json that respects the on-disk agents format. */
export function serializeOpenClawConfig(config: unknown, space: number = 2): string {
  return JSON.stringify(toOpenClawDiskShape(config), null, space);
}

/** JSON.parse for openclaw.json that exposes `agents.list` in both formats. */
export function parseOpenClawConfig<T = any>(raw: string): T {
  return expandAgentEntries(JSON.parse(raw)) as T;
}
