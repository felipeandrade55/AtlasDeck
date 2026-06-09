/**
 * Simplified recurrence expansion for the AtlasDeck calendar.
 *
 * Supports: daily, weekly, monthly, weekdays — with interval, until, count, byDay.
 * Expansion is always bounded by the requested range so callers can request weeks/months
 * without blowing up memory on long-running daily events.
 */

import { addDays, addMonths, isBefore, isAfter, parseISO } from "date-fns";
import type { CalendarEvent, EventException, ExpandedEvent, Recurrence } from "./calendar-types";

const MAX_OCCURRENCES_PER_EVENT = 200;

function parseRecurrence(event: CalendarEvent): Recurrence | null {
  if (!event.recurrence_json) return null;
  try {
    return JSON.parse(event.recurrence_json) as Recurrence;
  } catch {
    return null;
  }
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eventDuration(event: CalendarEvent): number {
  return parseISO(event.end_at).getTime() - parseISO(event.start_at).getTime();
}

function shiftEvent(event: CalendarEvent, newStart: Date): ExpandedEvent {
  const duration = eventDuration(event);
  const newEnd = new Date(newStart.getTime() + duration);
  return {
    ...event,
    start_at: newStart.toISOString(),
    end_at: newEnd.toISOString(),
    // Conclusão é por ocorrência (via exceção), nunca herdada da série.
    completed_at: null,
    is_recurring_instance: true,
    occurrence_date: dayKey(newStart),
  };
}

function shouldEmit(date: Date, recurrence: Recurrence, anchor: Date): boolean {
  const interval = recurrence.interval && recurrence.interval > 0 ? recurrence.interval : 1;

  switch (recurrence.freq) {
    case "daily": {
      const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86_400_000);
      return diffDays >= 0 && diffDays % interval === 0;
    }
    case "weekdays": {
      const dow = date.getDay();
      return dow >= 1 && dow <= 5;
    }
    case "weekly": {
      const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86_400_000);
      const diffWeeks = Math.floor(diffDays / 7);
      if (diffDays < 0 || diffWeeks % interval !== 0) return false;
      if (recurrence.byDay && recurrence.byDay.length > 0) {
        return recurrence.byDay.includes(date.getDay());
      }
      return date.getDay() === anchor.getDay();
    }
    case "monthly": {
      const monthsBetween =
        (date.getFullYear() - anchor.getFullYear()) * 12 + (date.getMonth() - anchor.getMonth());
      if (monthsBetween < 0 || monthsBetween % interval !== 0) return false;
      return date.getDate() === anchor.getDate();
    }
    default:
      return false;
  }
}

export function expandRecurrence(
  event: CalendarEvent,
  rangeStart: Date,
  rangeEnd: Date,
  exceptions: EventException[] = []
): ExpandedEvent[] {
  const recurrence = parseRecurrence(event);

  if (!recurrence) {
    const start = parseISO(event.start_at);
    const end = parseISO(event.end_at);
    if (end <= rangeStart || start >= rangeEnd) return [];
    return [{ ...event, is_recurring_instance: false, occurrence_date: null }];
  }

  const anchor = parseISO(event.start_at);
  const until = recurrence.until ? parseISO(recurrence.until) : null;
  const maxCount = recurrence.count && recurrence.count > 0 ? recurrence.count : MAX_OCCURRENCES_PER_EVENT;

  const exceptionMap = new Map<string, EventException>();
  for (const ex of exceptions) {
    exceptionMap.set(ex.occurrence_date, ex);
  }

  const occurrences: ExpandedEvent[] = [];
  let emitted = 0;

  let cursor = new Date(anchor.getTime());

  let iterEnd = rangeEnd;
  if (until && until < iterEnd) iterEnd = until;

  const hardLimit = recurrence.freq === "monthly" ? 60 : 800;
  let iterations = 0;

  while (cursor < iterEnd && emitted < maxCount && iterations < hardLimit) {
    iterations++;

    if (cursor >= rangeStart && shouldEmit(cursor, recurrence, anchor)) {
      const exception = exceptionMap.get(dayKey(cursor));

      if (!exception) {
        occurrences.push(shiftEvent(event, cursor));
        emitted++;
      } else if (exception.action === "completed") {
        // Ocorrência marcada como realizada: emitimos normalmente, porém com
        // completed_at preenchido para a UI riscar/colorir só esta data.
        const occ = shiftEvent(event, cursor);
        occ.completed_at = exception.created_at;
        occurrences.push(occ);
        emitted++;
      } else if (exception.action === "moved" && exception.new_event_id) {
        // Moved occurrence: caller is responsible for fetching the replacement event by id.
        // We skip emitting here so it doesn't appear at the original slot.
      }
    } else if (cursor < rangeStart && shouldEmit(cursor, recurrence, anchor)) {
      emitted++;
    }

    if (recurrence.freq === "monthly") {
      cursor = addMonths(cursor, 1);
    } else {
      cursor = addDays(cursor, 1);
    }
  }

  return occurrences;
}

export function expandEvents(
  events: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date,
  exceptionsByParent: Map<string, EventException[]> = new Map()
): ExpandedEvent[] {
  const result: ExpandedEvent[] = [];
  for (const event of events) {
    const exceptions = exceptionsByParent.get(event.id) ?? [];
    const expanded = expandRecurrence(event, rangeStart, rangeEnd, exceptions);
    for (const occ of expanded) {
      const start = parseISO(occ.start_at);
      const end = parseISO(occ.end_at);
      if (isBefore(end, rangeStart) || isAfter(start, rangeEnd)) continue;
      result.push(occ);
    }
  }
  result.sort((a, b) => a.start_at.localeCompare(b.start_at));
  return result;
}
