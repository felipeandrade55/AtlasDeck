"use client";

import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarBlock,
  EventReminder,
  ExpandedEvent,
  RescheduleQueueItem,
  BookingLink,
  Booking,
} from "./calendar-types";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error || JSON.stringify(body);
    } catch {
      detail = await res.text();
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchEventsInRange(from: Date, to: Date): Promise<ExpandedEvent[]> {
  const res = await fetch(
    `/api/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    { cache: "no-store" }
  );
  const data = await jsonOrThrow<{ events: ExpandedEvent[] }>(res);
  return data.events;
}

export async function fetchEventById(id: string): Promise<{ event: CalendarEvent; reminders: EventReminder[] }> {
  const res = await fetch(`/api/calendar/events/${id}`, { cache: "no-store" });
  return jsonOrThrow(res);
}

export async function createEventApi(payload: CalendarEventInput): Promise<CalendarEvent> {
  const res = await fetch(`/api/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await jsonOrThrow<{ event: CalendarEvent }>(res);
  return data.event;
}

export async function updateEventApi(id: string, payload: Partial<CalendarEventInput>): Promise<CalendarEvent> {
  const res = await fetch(`/api/calendar/events/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await jsonOrThrow<{ event: CalendarEvent }>(res);
  return data.event;
}

export async function deleteEventApi(id: string): Promise<void> {
  const res = await fetch(`/api/calendar/events/${id}`, { method: "DELETE" });
  await jsonOrThrow(res);
}

/**
 * Marca um compromisso como realizado (ou desfaz). Para ocorrências de eventos
 * recorrentes, passe `occurrenceDate` (ex.: "2026-06-09") para afetar só aquela data.
 */
export async function setEventCompletedApi(
  id: string,
  completed: boolean,
  occurrenceDate?: string | null
): Promise<void> {
  const res = await fetch(`/api/calendar/events/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed, occurrence_date: occurrenceDate ?? null }),
  });
  await jsonOrThrow(res);
}

export async function fetchBlocks(from: Date, to: Date): Promise<CalendarBlock[]> {
  const res = await fetch(
    `/api/calendar/blocks?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    { cache: "no-store" }
  );
  const data = await jsonOrThrow<{ blocks: CalendarBlock[] }>(res);
  return data.blocks;
}

export async function createBlockApi(payload: {
  start_at: string;
  end_at: string;
  all_day: boolean;
  title?: string;
  reason?: string;
}): Promise<{ block: CalendarBlock; conflicts: number }> {
  const res = await fetch(`/api/calendar/blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res);
}

export async function deleteBlockApi(id: string): Promise<void> {
  const res = await fetch(`/api/calendar/blocks/${id}`, { method: "DELETE" });
  await jsonOrThrow(res);
}

export async function fetchRescheduleQueue(): Promise<{
  items: Array<RescheduleQueueItem & { original_event?: CalendarEvent | null; block?: CalendarBlock | null }>;
}> {
  const res = await fetch(`/api/calendar/reschedule-queue?status=pending`, { cache: "no-store" });
  return jsonOrThrow(res);
}

export async function fetchRescheduleSuggestions(
  queueId: string
): Promise<{ suggestions: Array<{ start_at: string; end_at: string }> }> {
  const res = await fetch(`/api/calendar/reschedule-queue/${queueId}/suggestions`, { cache: "no-store" });
  return jsonOrThrow(res);
}

export async function applyRescheduleApi(
  queueId: string,
  payload: { new_start_at: string; new_end_at?: string }
): Promise<void> {
  const res = await fetch(`/api/calendar/reschedule-queue/${queueId}/reschedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await jsonOrThrow(res);
}

export async function cancelRescheduleApi(queueId: string): Promise<void> {
  const res = await fetch(`/api/calendar/reschedule-queue/${queueId}/cancel`, { method: "POST" });
  await jsonOrThrow(res);
}

export async function fetchBookingLinks(): Promise<BookingLink[]> {
  const res = await fetch(`/api/calendar/booking-links`, { cache: "no-store" });
  const data = await jsonOrThrow<{ links: BookingLink[] }>(res);
  return data.links;
}

export async function createBookingLinkApi(payload: {
  title: string;
  duration_minutes: number;
  description?: string;
  expires_at?: string | null;
  max_uses?: number | null;
}): Promise<BookingLink> {
  const res = await fetch(`/api/calendar/booking-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await jsonOrThrow<{ link: BookingLink }>(res);
  return data.link;
}

export async function deleteBookingLinkApi(id: string): Promise<void> {
  const res = await fetch(`/api/calendar/booking-links/${id}`, { method: "DELETE" });
  await jsonOrThrow(res);
}

export async function fetchBookings(status?: string): Promise<Booking[]> {
  const url = status ? `/api/calendar/bookings?status=${status}` : `/api/calendar/bookings`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await jsonOrThrow<{ bookings: Booking[] }>(res);
  return data.bookings;
}

export async function approveBookingApi(id: string): Promise<void> {
  const res = await fetch(`/api/calendar/bookings/${id}/approve`, { method: "POST" });
  await jsonOrThrow(res);
}

export async function rejectBookingApi(id: string, reason?: string): Promise<void> {
  const res = await fetch(`/api/calendar/bookings/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  await jsonOrThrow(res);
}

export function eventColor(event: { color?: string | null; source?: string | null }): string {
  if (event.color) return event.color;
  if (event.source === "booking") return "#0A84FF";
  return "#FF3B30";
}
