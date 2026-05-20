import { NextRequest, NextResponse } from "next/server";
import { suggestSlotsForQueueItem } from "@/lib/calendar-reschedule";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const result = suggestSlotsForQueueItem(id);
    if (!result) return NextResponse.json({ error: "Queue item not found" }, { status: 404 });
    return NextResponse.json({ suggestions: result.suggestions, original_event: result.original_event });
  } catch (error) {
    console.error("Failed to compute suggestions:", error);
    return NextResponse.json({ error: "Failed to compute suggestions" }, { status: 500 });
  }
}
