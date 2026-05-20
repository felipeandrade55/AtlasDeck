/**
 * Free-slot computation for the public booking flow.
 *
 * Reads availability rules + existing events + active blocks + pending bookings
 * and produces a list of {start_at, end_at} slots respecting the link duration.
 */

import { addDays, addMinutes, isSameDay, startOfDay } from "date-fns";
import type { AvailabilityRule, Booking, CalendarBlock, CalendarEvent } from "./calendar-types";

interface BusyRange {
  start: Date;
  end: Date;
}

function rulesForWeekday(rules: AvailabilityRule[], date: Date): AvailabilityRule[] {
  return rules.filter((r) => r.active && r.day_of_week === date.getDay());
}

function parseTimeOnDate(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  const d = new Date(date);
  d.setHours(h, m ?? 0, 0, 0);
  return d;
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function findFreeWindows(
  start: Date,
  end: Date,
  busy: BusyRange[]
): { start: Date; end: Date }[] {
  const sorted = busy
    .filter((b) => b.end > start && b.start < end)
    .map((b) => ({
      start: b.start < start ? start : b.start,
      end: b.end > end ? end : b.end,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const result: { start: Date; end: Date }[] = [];
  let cursor = new Date(start);
  for (const b of sorted) {
    if (b.start > cursor) result.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < end) result.push({ start: cursor, end });
  return result;
}

function* iterateSlots(
  window: { start: Date; end: Date },
  durationMinutes: number,
  stepMinutes: number
): Generator<{ start: Date; end: Date }> {
  const stepMs = stepMinutes * 60 * 1000;
  const durationMs = durationMinutes * 60 * 1000;
  let cursor = window.start.getTime();
  while (cursor + durationMs <= window.end.getTime()) {
    yield { start: new Date(cursor), end: new Date(cursor + durationMs) };
    cursor += stepMs;
  }
}

export function computeFreeSlots(params: {
  from: Date;
  to: Date;
  durationMinutes: number;
  rules: AvailabilityRule[];
  events: CalendarEvent[];
  blocks: CalendarBlock[];
  pendingBookings: Booking[];
  now?: Date;
}): { start_at: string; end_at: string }[] {
  const { from, to, durationMinutes, rules, events, blocks, pendingBookings, now } = params;
  const lowerBound = now ?? new Date();

  const slots: { start_at: string; end_at: string }[] = [];

  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    const todayRules = rulesForWeekday(rules, day);
    if (todayRules.length === 0) continue;

    const busy: BusyRange[] = [];
    for (const ev of events) {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      if (isSameDay(s, day) || isSameDay(e, day) || (s < day && e > day)) {
        busy.push({ start: s, end: e });
      }
    }
    for (const block of blocks) {
      const s = new Date(block.start_at);
      const e = new Date(block.end_at);
      if (isSameDay(s, day) || isSameDay(e, day) || (s < day && e > day)) {
        busy.push({ start: s, end: e });
      }
    }
    for (const b of pendingBookings) {
      if (b.status !== "pending" && b.status !== "approved") continue;
      const s = new Date(b.start_at);
      const e = new Date(b.end_at);
      if (isSameDay(s, day) || isSameDay(e, day) || (s < day && e > day)) {
        busy.push({ start: s, end: e });
      }
    }

    for (const rule of todayRules) {
      const ruleStart = parseTimeOnDate(day, rule.start_time);
      const ruleEnd = parseTimeOnDate(day, rule.end_time);
      if (ruleEnd <= ruleStart) continue;

      const effectiveStart = ruleStart < lowerBound ? lowerBound : ruleStart;
      if (effectiveStart >= ruleEnd) continue;

      const free = findFreeWindows(effectiveStart, ruleEnd, busy);
      const step = rule.slot_minutes || durationMinutes;

      for (const window of free) {
        for (const slot of iterateSlots(window, durationMinutes, step)) {
          if (slot.end > to) break;
          slots.push({ start_at: slot.start.toISOString(), end_at: slot.end.toISOString() });
        }
      }
    }
  }

  slots.sort((a, b) => a.start_at.localeCompare(b.start_at));
  return slots;
}

export function isSlotStillAvailable(params: {
  start: Date;
  end: Date;
  rules: AvailabilityRule[];
  events: CalendarEvent[];
  blocks: CalendarBlock[];
  pendingBookings: Booking[];
}): boolean {
  const { start, end, rules, events, blocks, pendingBookings } = params;
  const dayRules = rulesForWeekday(rules, start);
  if (dayRules.length === 0) return false;

  const insideAnyRule = dayRules.some((rule) => {
    const ruleStart = parseTimeOnDate(start, rule.start_time);
    const ruleEnd = parseTimeOnDate(start, rule.end_time);
    return start >= ruleStart && end <= ruleEnd;
  });
  if (!insideAnyRule) return false;

  for (const ev of events) {
    if (rangesOverlap(start, end, new Date(ev.start_at), new Date(ev.end_at))) return false;
  }
  for (const b of blocks) {
    if (rangesOverlap(start, end, new Date(b.start_at), new Date(b.end_at))) return false;
  }
  for (const b of pendingBookings) {
    if (b.status !== "pending" && b.status !== "approved") continue;
    if (rangesOverlap(start, end, new Date(b.start_at), new Date(b.end_at))) return false;
  }
  return true;
}

export function suggestSlotsForEvent(params: {
  originalStart: Date;
  durationMinutes: number;
  daysAhead: number[];
  rules: AvailabilityRule[];
  events: CalendarEvent[];
  blocks: CalendarBlock[];
  pendingBookings: Booking[];
  maxSuggestions?: number;
}): { start_at: string; end_at: string }[] {
  const { originalStart, durationMinutes, daysAhead, rules, events, blocks, pendingBookings } = params;
  const max = params.maxSuggestions ?? 6;
  const seen = new Set<string>();
  const all: { start_at: string; end_at: string }[] = [];

  for (const offset of daysAhead) {
    const dayStart = startOfDay(addDays(originalStart, offset));
    const dayEnd = addMinutes(dayStart, 24 * 60 - 1);
    const slots = computeFreeSlots({
      from: dayStart,
      to: dayEnd,
      durationMinutes,
      rules,
      events,
      blocks,
      pendingBookings,
    });
    for (const slot of slots) {
      if (seen.has(slot.start_at)) continue;
      seen.add(slot.start_at);
      all.push(slot);
      if (all.length >= max) return all;
    }
  }

  return all;
}
