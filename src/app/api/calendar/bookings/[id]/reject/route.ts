import { NextRequest, NextResponse } from "next/server";
import { getBookingById, updateBookingStatus } from "@/lib/calendar-db";
import { addNotification } from "@/lib/notifications";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const booking = getBookingById(id);
    if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    if (booking.status !== "pending") {
      return NextResponse.json({ error: "Booking is not pending" }, { status: 409 });
    }

    let reason = "";
    try {
      const body = await request.json();
      reason = body?.reason ?? "";
    } catch {
      reason = "";
    }

    updateBookingStatus(booking.id, "rejected");

    try {
      logActivity(
        "calendar",
        `Agendamento rejeitado: ${booking.name}${reason ? ` — ${reason}` : ""}`,
        "success",
        { metadata: { bookingId: booking.id, reason } }
      );
    } catch {}

    void addNotification(
      "❌ Agendamento rejeitado",
      `${booking.name} (${booking.requester_email})${reason ? ` — ${reason}` : ""}`,
      "warning",
      `/calendar`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to reject booking:", error);
    return NextResponse.json({ error: "Failed to reject booking" }, { status: 500 });
  }
}
