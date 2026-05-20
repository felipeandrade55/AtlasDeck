import { NextRequest, NextResponse } from "next/server";
import { getBlockById, getEventById, listRescheduleQueue } from "@/lib/calendar-db";
import type { RescheduleStatus } from "@/lib/calendar-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = (searchParams.get("status") as RescheduleStatus | null) ?? "pending";
    const items = listRescheduleQueue(status);

    const enriched = items.map((item) => ({
      ...item,
      original_event: getEventById(item.original_event_id),
      block: getBlockById(item.block_id),
    }));

    return NextResponse.json({ items: enriched });
  } catch (error) {
    console.error("Failed to list reschedule queue:", error);
    return NextResponse.json({ error: "Failed to list queue" }, { status: 500 });
  }
}
