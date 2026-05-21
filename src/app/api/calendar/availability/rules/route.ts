import { NextRequest, NextResponse } from "next/server";
import {
  createAvailabilityRule,
  deleteAvailabilityRule,
  listAvailabilityRules,
  updateAvailabilityRule,
} from "@/lib/calendar-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rules = listAvailabilityRules(false);
    return NextResponse.json({ rules });
  } catch (error) {
    console.error("Failed to list availability rules:", error);
    return NextResponse.json({ error: "Failed to list rules" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (
      typeof body.day_of_week !== "number" ||
      typeof body.start_time !== "string" ||
      typeof body.end_time !== "string"
    ) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    const lunchStart = typeof body.lunch_start === "string" && body.lunch_start ? body.lunch_start : null;
    const lunchEnd = typeof body.lunch_end === "string" && body.lunch_end ? body.lunch_end : null;
    const rule = createAvailabilityRule({
      day_of_week: body.day_of_week,
      start_time: body.start_time,
      end_time: body.end_time,
      slot_minutes: body.slot_minutes ?? 30,
      timezone: body.timezone ?? "UTC",
      active: body.active !== false,
      lunch_start: lunchStart && lunchEnd ? lunchStart : null,
      lunch_end: lunchStart && lunchEnd ? lunchEnd : null,
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    console.error("Failed to create rule:", error);
    return NextResponse.json({ error: "Failed to create rule" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const updated = updateAvailabilityRule(body.id, body);
    return NextResponse.json({ rule: updated });
  } catch (error) {
    console.error("Failed to update rule:", error);
    return NextResponse.json({ error: "Failed to update rule" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const ok = deleteAvailabilityRule(id);
    if (!ok) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete rule:", error);
    return NextResponse.json({ error: "Failed to delete rule" }, { status: 500 });
  }
}
