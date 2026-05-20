import { NextRequest, NextResponse } from "next/server";
import { addDays } from "date-fns";
import {
  listAllBlocks,
  listAvailabilityRules,
  listBookings,
  listEventsInRange,
} from "@/lib/calendar-db";
import { computeFreeSlots } from "@/lib/availability";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const durationParam = searchParams.get("duration");

    const duration = Number(durationParam ?? "30");
    if (!Number.isFinite(duration) || duration <= 0) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }

    let from: Date;
    let to: Date;
    if (fromParam && toParam) {
      from = new Date(fromParam);
      to = new Date(toParam);
    } else if (dateParam) {
      from = new Date(dateParam);
      from.setHours(0, 0, 0, 0);
      to = addDays(from, 1);
    } else {
      return NextResponse.json({ error: "Missing date or from/to" }, { status: 400 });
    }

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: "Invalid datetimes" }, { status: 400 });
    }

    const rules = listAvailabilityRules(true);
    const events = listEventsInRange(from.toISOString(), to.toISOString());
    const blocks = listAllBlocks().filter((b) => new Date(b.end_at) > from && new Date(b.start_at) < to);
    const pending = listBookings("pending").concat(listBookings("approved"));

    const slots = computeFreeSlots({
      from,
      to,
      durationMinutes: duration,
      rules,
      events,
      blocks,
      pendingBookings: pending,
    });

    return NextResponse.json({ slots });
  } catch (error) {
    console.error("Failed to compute availability:", error);
    return NextResponse.json({ error: "Failed to compute availability" }, { status: 500 });
  }
}
