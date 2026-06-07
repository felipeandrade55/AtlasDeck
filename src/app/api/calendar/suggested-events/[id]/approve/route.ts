/**
 * Approve a suggested event → create a real calendar event (with reminders),
 * mark the suggestion approved. Accepts optional overrides for date/title/
 * location (the UI prefills them from the suggestion and lets the user adjust;
 * a start date is required to create the event).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSuggestedEventById,
  updateSuggestedEvent,
  createEvent,
} from "@/lib/calendar-db";
import { logActivity } from "@/lib/activities-db";
import { addNotification } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = getSuggestedEventById(id);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status !== "pending") {
    return NextResponse.json({ error: "Sugestão já resolvida" }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const title = (typeof body.title === "string" && body.title.trim()) || item.title;
  const startAt = (typeof body.start_at === "string" && body.start_at) || item.start_at;
  const location = body.location !== undefined ? body.location : item.location;

  if (!startAt) {
    return NextResponse.json(
      { error: "Defina uma data/hora de início para criar o evento" },
      { status: 400 }
    );
  }

  let endAt = (typeof body.end_at === "string" && body.end_at) || item.end_at;
  if (!endAt) {
    const d = new Date(startAt);
    endAt = Number.isNaN(d.getTime())
      ? startAt
      : new Date(d.getTime() + 60 * 60 * 1000).toISOString();
  }

  try {
    const event = createEvent({
      title,
      description: item.source_text ?? null,
      location: location ?? null,
      start_at: startAt,
      end_at: endAt,
      all_day: false,
      timezone: "America/Sao_Paulo",
      status: "confirmed",
      source: "openclaw",
      reminders: [
        { minutes_before: 30, channel: "notification" },
        { minutes_before: 30, channel: "telegram" },
      ],
    });

    updateSuggestedEvent(id, { status: "approved", event_id: event.id });

    try {
      logActivity("calendar", `Compromisso aprovado da transcrição: ${title}`, "success", {
        metadata: { source: "transcription", suggested_id: id, event_id: event.id },
      });
    } catch {}
    try {
      await addNotification(
        "✅ Compromisso criado",
        `"${title}" foi adicionado à agenda com lembrete.`,
        "success",
        "/calendar",
        { source: "transcription", event_id: event.id }
      );
    } catch {}

    return NextResponse.json({ success: true, event });
  } catch (err) {
    console.error("[/api/calendar/suggested-events/approve] failed:", err);
    return NextResponse.json({ error: "Falha ao criar evento" }, { status: 500 });
  }
}
