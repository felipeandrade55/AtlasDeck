import { NextRequest, NextResponse } from "next/server";
import { listBookings } from "@/lib/calendar-db";
import type { BookingStatus } from "@/lib/calendar-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") as BookingStatus | null;
    const bookings = status ? listBookings(status) : listBookings();
    return NextResponse.json({ bookings });
  } catch (error) {
    console.error("Failed to list bookings:", error);
    return NextResponse.json({ error: "Failed to list bookings" }, { status: 500 });
  }
}
