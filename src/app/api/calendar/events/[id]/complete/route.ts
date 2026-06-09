import { NextRequest, NextResponse } from "next/server";
import {
  getEventById,
  listRemindersForEvent,
  setEventCompleted,
  setOccurrenceCompleted,
} from "@/lib/calendar-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Marca um compromisso como realizado (ou desfaz).
 *
 * Body: { completed: boolean, occurrence_date?: string | null }
 * - Sem `occurrence_date`: marca o evento (não recorrente) inteiro.
 * - Com `occurrence_date` (ex.: "2026-06-09"): marca apenas aquela ocorrência
 *   da série recorrente, via exceção — as demais datas não são afetadas.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      completed?: boolean;
      occurrence_date?: string | null;
    };

    if (typeof body.completed !== "boolean") {
      return NextResponse.json({ error: "Field 'completed' (boolean) is required" }, { status: 400 });
    }

    const existing = getEventById(id);
    if (!existing) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const occurrenceDate = body.occurrence_date?.slice(0, 10) || null;

    if (occurrenceDate) {
      setOccurrenceCompleted(id, occurrenceDate, body.completed);
    } else {
      setEventCompleted(id, body.completed);
    }

    try {
      const verb = body.completed ? "realizado" : "reaberto";
      logActivity("calendar", `Compromisso ${verb}: ${existing.title}`, "success", {
        metadata: { eventId: id, occurrence_date: occurrenceDate, completed: body.completed },
      });
    } catch {}

    const event = getEventById(id);
    return NextResponse.json({ event, reminders: listRemindersForEvent(id) });
  } catch (error) {
    console.error("Failed to toggle event completion:", error);
    return NextResponse.json({ error: "Failed to toggle completion" }, { status: 500 });
  }
}
