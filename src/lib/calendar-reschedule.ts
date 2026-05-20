/**
 * Reschedule queue resolution: suggest slots and apply a new datetime to a queue item.
 */

import {
  createEvent,
  getEventById,
  getRescheduleItemById,
  listAllBlocks,
  listAvailabilityRules,
  listBookings,
  listEventsInRange,
  runInTransaction,
  updateBookingStatus,
  updateEvent,
  updateRescheduleItem,
  listExceptions,
  insertException,
} from "./calendar-db";
import { suggestSlotsForEvent } from "./availability";
import type { CalendarEvent, RescheduleQueueItem } from "./calendar-types";

export function suggestSlotsForQueueItem(queueId: string): {
  item: RescheduleQueueItem;
  original_event: CalendarEvent | null;
  suggestions: { start_at: string; end_at: string }[];
} | null {
  const item = getRescheduleItemById(queueId);
  if (!item) return null;
  const event = getEventById(item.original_event_id);
  if (!event) {
    return { item, original_event: null, suggestions: [] };
  }
  const durationMs = new Date(item.original_end).getTime() - new Date(item.original_start).getTime();
  const durationMinutes = Math.max(15, Math.round(durationMs / 60000));

  const rules = listAvailabilityRules(true);
  const refDate = new Date(item.original_start);
  const lookahead = new Date(refDate);
  lookahead.setDate(lookahead.getDate() + 30);
  const events = listEventsInRange(refDate.toISOString(), lookahead.toISOString());
  const blocks = listAllBlocks().filter(
    (b) => new Date(b.end_at) >= refDate && new Date(b.start_at) <= lookahead
  );
  const pending = listBookings("pending").concat(listBookings("approved"));

  const suggestions = suggestSlotsForEvent({
    originalStart: refDate,
    durationMinutes,
    daysAhead: [1, 2, 3, 7, 14],
    rules,
    events,
    blocks,
    pendingBookings: pending,
    maxSuggestions: 6,
  });

  return { item, original_event: event, suggestions };
}

export interface ApplyRescheduleInput {
  queueId: string;
  newStart: string;
  newEnd?: string;
}

export interface ApplyRescheduleResult {
  ok: boolean;
  error?: string;
  new_event_id?: string;
}

export function applyReschedule(input: ApplyRescheduleInput): ApplyRescheduleResult {
  return runInTransaction(() => {
    const item = getRescheduleItemById(input.queueId);
    if (!item) return { ok: false, error: "Queue item not found" };
    if (item.status !== "pending") return { ok: false, error: "Item is not pending" };

    const original = getEventById(item.original_event_id);
    if (!original) return { ok: false, error: "Original event not found" };

    const newStart = new Date(input.newStart);
    const newEnd = input.newEnd
      ? new Date(input.newEnd)
      : new Date(newStart.getTime() + (new Date(item.original_end).getTime() - new Date(item.original_start).getTime()));

    if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime()) || newEnd <= newStart) {
      return { ok: false, error: "Invalid datetimes" };
    }

    if (original.recurrence_json) {
      const occurrenceKey = new Date(item.original_start).toISOString().slice(0, 10);
      const replacement = createEvent({
        title: original.title,
        description: original.description,
        location: original.location,
        start_at: newStart.toISOString(),
        end_at: newEnd.toISOString(),
        all_day: original.all_day,
        timezone: original.timezone,
        color: original.color,
        status: "confirmed",
        source: original.source,
        parent_booking_id: original.parent_booking_id,
      });

      const existing = listExceptions(original.id).find(
        (ex) => ex.occurrence_date === occurrenceKey
      );
      if (!existing) {
        insertException({
          parent_event_id: original.id,
          occurrence_date: occurrenceKey,
          action: "moved",
          new_event_id: replacement.id,
        });
      }

      updateRescheduleItem(item.id, {
        status: "rescheduled",
        new_event_id: replacement.id,
      });
      return { ok: true, new_event_id: replacement.id };
    }

    const updated = updateEvent(original.id, {
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      status: "confirmed",
    });
    if (!updated) return { ok: false, error: "Failed to move event" };

    if (original.parent_booking_id) {
      updateBookingStatus(original.parent_booking_id, "approved", original.id);
    }

    updateRescheduleItem(item.id, {
      status: "rescheduled",
      new_event_id: original.id,
    });

    return { ok: true, new_event_id: original.id };
  });
}

export function cancelRescheduleItem(queueId: string): boolean {
  return runInTransaction(() => {
    const item = getRescheduleItemById(queueId);
    if (!item) return false;
    if (item.status !== "pending") return false;
    updateRescheduleItem(item.id, { status: "cancelled" });
    return true;
  });
}
