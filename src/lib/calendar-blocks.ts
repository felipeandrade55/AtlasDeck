/**
 * Block management: creating a block detects conflicting events in the same range
 * and pushes each one to the reschedule queue inside a single SQLite transaction.
 */

import {
  cancelQueueItemsForBlock,
  deleteBlock,
  findEventsInRange,
  insertBlockRow,
  insertException,
  insertRescheduleItem,
  runInTransaction,
} from "./calendar-db";
import type { CalendarBlock, RescheduleQueueItem } from "./calendar-types";

const MAX_CONFLICTS_PER_BLOCK = 50;

export interface CreateBlockInput {
  start_at: string;
  end_at: string;
  all_day: boolean;
  title?: string | null;
  reason?: string | null;
  source: CalendarBlock["source"];
}

export interface CreateBlockResult {
  block: CalendarBlock;
  conflicts: RescheduleQueueItem[];
  truncated: boolean;
}

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function createBlockWithConflicts(input: CreateBlockInput): CreateBlockResult {
  return runInTransaction(() => {
    const block = insertBlockRow({
      start_at: input.start_at,
      end_at: input.end_at,
      all_day: input.all_day,
      title: input.title ?? null,
      reason: input.reason ?? null,
      source: input.source,
    });

    const events = findEventsInRange(block.start_at, block.end_at);
    const limitedEvents = events.slice(0, MAX_CONFLICTS_PER_BLOCK);

    const queueItems: RescheduleQueueItem[] = [];
    for (const event of limitedEvents) {
      if (event.recurrence_json) {
        insertException({
          parent_event_id: event.id,
          occurrence_date: dayKey(event.start_at),
          action: "moved",
          new_event_id: null,
        });
      }

      const item = insertRescheduleItem({
        original_event_id: event.id,
        block_id: block.id,
        original_start: event.start_at,
        original_end: event.end_at,
        reason: input.reason ?? input.title ?? "Bloqueio criado",
      });
      queueItems.push(item);
    }

    return {
      block,
      conflicts: queueItems,
      truncated: events.length > MAX_CONFLICTS_PER_BLOCK,
    };
  });
}

export function removeBlock(blockId: string): boolean {
  return runInTransaction(() => {
    cancelQueueItemsForBlock(blockId, "Bloqueio removido");
    return deleteBlock(blockId);
  });
}
