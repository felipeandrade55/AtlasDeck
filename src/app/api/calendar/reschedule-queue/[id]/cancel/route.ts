import { NextRequest, NextResponse } from "next/server";
import { cancelRescheduleItem } from "@/lib/calendar-reschedule";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const ok = cancelRescheduleItem(id);
    if (!ok) return NextResponse.json({ error: "Item not pending or not found" }, { status: 404 });
    try {
      logActivity("calendar", `Item de remarcação cancelado`, "success", { metadata: { queueId: id } });
    } catch {}
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to cancel reschedule item:", error);
    return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
  }
}
