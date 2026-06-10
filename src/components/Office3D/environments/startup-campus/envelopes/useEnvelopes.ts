'use client';

/**
 * Envelope state for the Startup Campus. Tasks are physical mail:
 *
 *   inbox            → envelope on the reception conveyor
 *   awaiting-pickup  → assigned + a pending errand sends the owner to
 *                      reception (errand cleared by AgentActor on arrival)
 *   carried          → owned; the Envelope mesh follows the agent and
 *                      settles on their desk (visual, distance-based)
 *   in-review        → stacked on the QA desk
 *
 * Everything is DERIVED (useMemo) from the live `tasks` list + the errand
 * store — no replayed-event bookkeeping, idempotent by construction. The
 * only side effect is errand creation, driven by FRESH SSE events (replay
 * frames are older than 60s and get skipped).
 */
import { useEffect, useMemo } from 'react';
import type { Task } from '@/components/LiveMission/types';
import type { OfficeBus } from '../../../shared/data/OfficeDataProvider';
import { useOfficeStore } from '../../../shared/data/officeStore';
import type { EnvLayout } from '../../../shared/behavior/behaviorTypes';

export type EnvelopePhase = 'inbox' | 'awaiting-pickup' | 'carried' | 'in-review';

export interface EnvelopeEntity {
  taskId: string;
  agentId: string | null;
  phase: EnvelopePhase;
  /** Conveyor slot (inbox) or per-desk/QA stack index. */
  slot: number;
  title: string;
}

const ENVELOPE_STATUSES = new Set(['inbox', 'planning', 'assigned', 'in_progress', 'testing', 'review']);
const OWNED_STATUSES = new Set(['assigned', 'in_progress', 'testing']);

export function useEnvelopes(tasks: Task[], layout: EnvLayout, bus: OfficeBus): Map<string, EnvelopeEntity> {
  const errands = useOfficeStore((s) => s.errands);

  // Side effect 1: fresh assignment events spawn a pickup errand.
  useEffect(() => {
    if (!layout.pickupAnchor) return;
    return bus.subscribe((e) => {
      if (e.event_type !== 'task.created' && e.event_type !== 'task.status_changed') return;
      const status =
        e.event_type === 'task.created' ? String(e.payload.status ?? 'inbox') : String(e.payload.to ?? '');
      if (!OWNED_STATUSES.has(status)) return;
      if (!e.agent_id || !e.task_id) return;
      // Replayed history (SSE reconnect re-sends ~80 events) is stale —
      // only react to events that just happened.
      if (Date.now() - new Date(e.created_at).getTime() > 60_000) return;
      const store = useOfficeStore.getState();
      if (store.errands.has(e.agent_id)) return; // one trip at a time
      store.setErrand(e.agent_id, { kind: 'pickup', taskId: e.task_id, anchor: layout.pickupAnchor! });
    });
  }, [bus, layout]);

  // Side effect 2: drop errands whose task left the active pipeline.
  useEffect(() => {
    const store = useOfficeStore.getState();
    const liveIds = new Set(tasks.filter((t) => ENVELOPE_STATUSES.has(t.status)).map((t) => t.id));
    for (const [agentId, errand] of store.errands) {
      if (!liveIds.has(errand.taskId)) store.setErrand(agentId, null);
    }
  }, [tasks]);

  return useMemo(() => {
    const map = new Map<string, EnvelopeEntity>();
    let conveyorSlot = 0;
    let reviewSlot = 0;
    const deskCount = new Map<string, number>();

    // Stable order so slots don't shuffle between refetches.
    const live = tasks
      .filter((t) => ENVELOPE_STATUSES.has(t.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    for (const task of live) {
      const agentId = task.assigned_to;
      let phase: EnvelopePhase;
      let slot: number;

      if (task.status === 'review') {
        phase = 'in-review';
        slot = reviewSlot++;
      } else if (!agentId || task.status === 'inbox' || task.status === 'planning') {
        phase = 'inbox';
        slot = conveyorSlot++;
      } else if (errands.get(agentId)?.taskId === task.id) {
        phase = 'awaiting-pickup';
        slot = conveyorSlot++; // still physically on the conveyor
      } else {
        phase = 'carried';
        const n = deskCount.get(agentId) ?? 0;
        slot = n;
        deskCount.set(agentId, n + 1);
      }

      map.set(task.id, {
        taskId: task.id,
        agentId,
        phase,
        slot,
        title: task.title || task.prompt.slice(0, 60),
      });
    }
    return map;
  }, [tasks, errands]);
}
