import { NextRequest, NextResponse } from "next/server";
import { addDays } from "date-fns";
import {
  getBookingLinkByToken,
  listAllBlocks,
  listAvailabilityRules,
  listBookings,
  listEventsInRange,
} from "@/lib/calendar-db";
import { computeFreeSlots } from "@/lib/availability";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { token } = await context.params;
    const link = getBookingLinkByToken(token);
    if (!link || !link.active) {
      return NextResponse.json({ error: "Link not found or inactive" }, { status: 404 });
    }
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return NextResponse.json({ error: "Link expired" }, { status: 410 });
    }
    if (link.max_uses && link.uses >= link.max_uses) {
      return NextResponse.json({ error: "Link reached max uses" }, { status: 410 });
    }

    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");

    const from = fromParam ? new Date(fromParam) : new Date();
    const to = toParam ? new Date(toParam) : addDays(from, 14);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    const rules = listAvailabilityRules(true);
    const events = listEventsInRange(from.toISOString(), to.toISOString());
    const blocks = listAllBlocks().filter((b) => new Date(b.end_at) > from && new Date(b.start_at) < to);
    const pending = listBookings("pending").concat(listBookings("approved"));

    const slots = computeFreeSlots({
      from,
      to,
      durationMinutes: link.duration_minutes,
      rules,
      events,
      blocks,
      pendingBookings: pending,
    });

    return NextResponse.json({
      link: {
        id: link.id,
        token: link.token,
        title: link.title,
        description: link.description,
        duration_minutes: link.duration_minutes,
      },
      slots,
      range: { from: from.toISOString(), to: to.toISOString() },
    });
  } catch (error) {
    console.error("Failed to load public booking link:", error);
    return NextResponse.json({ error: "Failed to load link" }, { status: 500 });
  }
}
