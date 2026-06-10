'use client';

/**
 * Cross-component state for the 3D office that must NOT flow through
 * React props/state:
 *
 * - `positions` is mutated inside `useFrame` by every avatar at ~60fps.
 *   Readers always call `useOfficeStore.getState().positions` (never a
 *   reactive selector), so no React render is ever triggered by movement.
 *   This replaces the old `onPositionUpdate` → `setState(new Map())`
 *   pattern that re-rendered the whole tree per avatar per frame.
 *
 * - `errands` / `poiClaims` change rarely (task events, idle wandering)
 *   and ARE reactive — they're replaced immutably so components can
 *   subscribe with selectors.
 */
import { create } from 'zustand';
import { Vector3 } from 'three';
import type { Errand } from '../behavior/behaviorTypes';

interface OfficeStore {
  /** Live avatar positions, keyed by agent id. Transient — see header. */
  positions: Map<string, Vector3>;
  writePosition(agentId: string, pos: Vector3): void;
  removePosition(agentId: string): void;

  /** Pending one-off errands (envelope pickups), keyed by agent id. */
  errands: Map<string, Errand>;
  setErrand(agentId: string, errand: Errand | null): void;

  /** POI occupancy: poiId → agent ids currently claiming a slot. */
  poiClaims: Map<string, string[]>;
  /** Returns the claimed slot index, or null if the POI is full. */
  claimPoi(poiId: string, agentId: string, capacity: number): number | null;
  releasePoi(agentId: string): void;

  /**
   * Videowall interactive mode: pointer events go to the DOM panel and
   * OrbitControls is disabled. Toggled by clicking the videowall frame.
   */
  videowallInteractive: boolean;
  setVideowallInteractive(v: boolean): void;

  /** Clears everything — called when a scene unmounts (env toggle). */
  resetTransient(): void;
}

export const useOfficeStore = create<OfficeStore>((set, get) => ({
  positions: new Map(),
  writePosition(agentId, pos) {
    // In-place mutation on purpose: per-frame hot path, no notify.
    const map = get().positions;
    let v = map.get(agentId);
    if (!v) {
      v = new Vector3();
      map.set(agentId, v);
    }
    v.copy(pos);
  },
  removePosition(agentId) {
    get().positions.delete(agentId);
  },

  errands: new Map(),
  setErrand(agentId, errand) {
    set((s) => {
      const next = new Map(s.errands);
      if (errand) next.set(agentId, errand);
      else next.delete(agentId);
      return { errands: next };
    });
  },

  poiClaims: new Map(),
  claimPoi(poiId, agentId, capacity) {
    let slot: number | null = null;
    set((s) => {
      const current = s.poiClaims.get(poiId) ?? [];
      const existing = current.indexOf(agentId);
      if (existing !== -1) {
        slot = existing;
        return s;
      }
      if (current.length >= capacity) return s;
      const next = new Map(s.poiClaims);
      next.set(poiId, [...current, agentId]);
      slot = current.length;
      return { poiClaims: next };
    });
    return slot;
  },
  releasePoi(agentId) {
    set((s) => {
      let changed = false;
      const next = new Map(s.poiClaims);
      for (const [poiId, ids] of next) {
        if (ids.includes(agentId)) {
          const remaining = ids.filter((id) => id !== agentId);
          if (remaining.length === 0) next.delete(poiId);
          else next.set(poiId, remaining);
          changed = true;
        }
      }
      return changed ? { poiClaims: next } : s;
    });
  },

  videowallInteractive: false,
  setVideowallInteractive(v) {
    set({ videowallInteractive: v });
  },

  resetTransient() {
    get().positions.clear();
    set({ errands: new Map(), poiClaims: new Map(), videowallInteractive: false });
  },
}));
