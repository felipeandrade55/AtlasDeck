import { NextRequest, NextResponse } from "next/server";
import { cancelRescheduleItem } from "@/lib/calendar-reschedule";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const ok = cancelRescheduleItem(id);
    if (!ok) return NextResponse.json({ error: "Item not pending or not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to cancel reschedule item:", error);
    return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
  }
}
