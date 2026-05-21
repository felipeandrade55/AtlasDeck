import { NextRequest, NextResponse } from "next/server";
import { applyReschedule } from "@/lib/calendar-reschedule";
import { addNotification } from "@/lib/notifications";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    if (!body?.new_start_at) {
      return NextResponse.json({ error: "Missing new_start_at" }, { status: 400 });
    }

    const result = applyReschedule({
      queueId: id,
      newStart: body.new_start_at,
      newEnd: body.new_end_at,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    try {
      logActivity(
        "calendar",
        `Compromisso remarcado para ${new Date(body.new_start_at).toLocaleString("pt-BR")}`,
        "success",
        { metadata: { queueId: id, newEventId: result.new_event_id } }
      );
    } catch {}

    void addNotification(
      "✅ Compromisso remarcado",
      `Movido para ${new Date(body.new_start_at).toLocaleString("pt-BR")}`,
      "success",
      `/calendar?event=${result.new_event_id}`
    );

    return NextResponse.json({ success: true, event_id: result.new_event_id });
  } catch (error) {
    console.error("Failed to reschedule:", error);
    return NextResponse.json({ error: "Failed to reschedule" }, { status: 500 });
  }
}
