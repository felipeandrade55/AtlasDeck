import { NextRequest, NextResponse } from "next/server";
import {
  createEvent,
  listAllEvents,
  listEventsInRange,
  listExceptions,
  listRemindersForEvent,
} from "@/lib/calendar-db";
import { expandEvents } from "@/lib/calendar-recurrence";
import type { CalendarEventInput, EventException } from "@/lib/calendar-types";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const includeReminders = searchParams.get("include_reminders") === "true";

    if (!from || !to) {
      const all = listAllEvents();
      return NextResponse.json({ events: all, expanded: [] });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return NextResponse.json({ error: "Invalid from/to parameters" }, { status: 400 });
    }

    const raw = listEventsInRange(from, to);

    const exceptionsByParent = new Map<string, EventException[]>();
    for (const e of raw) {
      if (e.recurrence_json) {
        exceptionsByParent.set(e.id, listExceptions(e.id));
      }
    }

    const expanded = expandEvents(raw, fromDate, toDate, exceptionsByParent);

    if (includeReminders) {
      const withReminders = expanded.map((ev) => ({
        ...ev,
        reminders: listRemindersForEvent(ev.id),
      }));
      return NextResponse.json({ events: withReminders });
    }

    return NextResponse.json({ events: expanded });
  } catch (error) {
    console.error("Failed to list events:", error);
    return NextResponse.json({ error: "Failed to list events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<CalendarEventInput>;

    if (!body.title || !body.start_at || !body.end_at) {
      return NextResponse.json(
        { error: "Missing required fields: title, start_at, end_at" },
        { status: 400 }
      );
    }

    const start = new Date(body.start_at);
    const end = new Date(body.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return NextResponse.json({ error: "Invalid start_at/end_at" }, { status: 400 });
    }
    if (end <= start) {
      return NextResponse.json({ error: "end_at must be after start_at" }, { status: 400 });
    }

    const event = createEvent({
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: !!body.all_day,
      timezone: body.timezone ?? "UTC",
      color: body.color ?? null,
      status: body.status ?? "confirmed",
      recurrence: body.recurrence ?? null,
      source: body.source ?? "ui",
      parent_booking_id: body.parent_booking_id ?? null,
      reminders: body.reminders ?? [],
    });

    try {
      const when = start.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      logActivity("calendar", `Evento criado: ${event.title} — ${when}`, "success", {
        agent: body.source ?? "ui",
        metadata: { eventId: event.id, start_at: event.start_at, recurring: !!event.recurrence_json },
      });
    } catch {}

    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    console.error("Failed to create event:", error);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
