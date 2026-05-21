import { NextRequest, NextResponse } from "next/server";
import {
  deleteEvent,
  getEventById,
  listRemindersForEvent,
  updateEvent,
} from "@/lib/calendar-db";
import type { CalendarEventInput } from "@/lib/calendar-types";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const event = getEventById(id);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({ event, reminders: listRemindersForEvent(id) });
  } catch (error) {
    console.error("Failed to get event:", error);
    return NextResponse.json({ error: "Failed to get event" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as Partial<CalendarEventInput>;

    if (body.start_at && body.end_at) {
      const start = new Date(body.start_at);
      const end = new Date(body.end_at);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return NextResponse.json({ error: "Invalid datetimes" }, { status: 400 });
      }
      if (end <= start) {
        return NextResponse.json({ error: "end_at must be after start_at" }, { status: 400 });
      }
    }

    const updated = updateEvent(id, body);
    if (!updated) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    try {
      logActivity("calendar", `Evento atualizado: ${updated.title}`, "success", {
        metadata: { eventId: id, fields: Object.keys(body) },
      });
    } catch {}
    return NextResponse.json({ event: updated, reminders: listRemindersForEvent(id) });
  } catch (error) {
    console.error("Failed to update event:", error);
    return NextResponse.json({ error: "Failed to update event" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const existing = getEventById(id);
    const ok = deleteEvent(id);
    if (!ok) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    try {
      logActivity("calendar", `Evento excluído: ${existing?.title ?? id}`, "success", {
        metadata: { eventId: id },
      });
    } catch {}
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete event:", error);
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
  }
}
