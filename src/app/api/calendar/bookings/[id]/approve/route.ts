import { NextRequest, NextResponse } from "next/server";
import {
  createEvent,
  findEventsInRange,
  getBookingById,
  getBookingLinkById,
  listAllBlocks,
  runInTransaction,
  updateBookingStatus,
} from "@/lib/calendar-db";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const booking = getBookingById(id);
    if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    if (booking.status !== "pending") {
      return NextResponse.json({ error: "Booking is not pending" }, { status: 409 });
    }

    const link = getBookingLinkById(booking.link_id);
    const title = link ? `${link.title} — ${booking.name}` : `Reunião — ${booking.name}`;

    const result = runInTransaction(() => {
      const conflictingEvents = findEventsInRange(booking.start_at, booking.end_at);
      const blocks = listAllBlocks().filter(
        (b) => new Date(b.end_at) > new Date(booking.start_at) && new Date(b.start_at) < new Date(booking.end_at)
      );
      if (conflictingEvents.length > 0 || blocks.length > 0) {
        return { error: "Slot now conflicts with another event or block" } as const;
      }

      const event = createEvent({
        title,
        description: booking.message ?? null,
        start_at: booking.start_at,
        end_at: booking.end_at,
        all_day: false,
        timezone: "UTC",
        color: "#0A84FF",
        status: "confirmed",
        source: "booking",
        parent_booking_id: booking.id,
        reminders: [
          { minutes_before: 15, channel: "notification" },
          { minutes_before: 15, channel: "telegram" },
        ],
      });

      updateBookingStatus(booking.id, "approved", event.id);
      return { event } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    try {
      logActivity(
        "calendar",
        `Agendamento aprovado: ${booking.name} — ${new Date(booking.start_at).toLocaleString("pt-BR")}`,
        "success",
        { metadata: { bookingId: booking.id, eventId: result.event.id } }
      );
    } catch {}

    void Promise.allSettled([
      addNotification(
        "✅ Agendamento aprovado",
        `${booking.name} confirmado em ${new Date(booking.start_at).toLocaleString("pt-BR")}`,
        "success",
        `/calendar`,
        { event_id: result.event.id }
      ),
      sendTelegramAlert(
        "",
        "",
        `<b>✅ Agendamento aprovado</b>\n\n<b>${booking.name}</b>\n🗓️ ${new Date(booking.start_at).toLocaleString(
          "pt-BR"
        )}\n✉️ ${booking.requester_email}`
      ),
    ]);

    return NextResponse.json({ success: true, event_id: result.event.id });
  } catch (error) {
    console.error("Failed to approve booking:", error);
    return NextResponse.json({ error: "Failed to approve booking" }, { status: 500 });
  }
}
