import { NextRequest, NextResponse } from "next/server";
import {
  createBooking,
  findEventsInRange,
  getBookingLinkByToken,
  listAllBlocks,
  listAvailabilityRules,
  listBookings,
  runInTransaction,
} from "@/lib/calendar-db";
import { isSlotStillAvailable } from "@/lib/availability";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ token: string }>;
}

const ATTEMPTS_PER_HOUR = 8;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= ATTEMPTS_PER_HOUR;
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const ip = getClientIp(request);
    if (!rateLimit(ip)) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }

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

    const body = await request.json();
    if (!body?.start_at || !body?.name || !body?.email) {
      return NextResponse.json({ error: "Missing fields: name, email, start_at" }, { status: 400 });
    }
    // Honeypot field: clients shouldn't fill it
    if (body.website && String(body.website).length > 0) {
      return NextResponse.json({ error: "Spam detected" }, { status: 400 });
    }

    const start = new Date(body.start_at);
    if (Number.isNaN(start.getTime())) {
      return NextResponse.json({ error: "Invalid start_at" }, { status: 400 });
    }
    const end = new Date(start.getTime() + link.duration_minutes * 60 * 1000);

    const result = runInTransaction(() => {
      const rules = listAvailabilityRules(true);
      const events = findEventsInRange(start.toISOString(), end.toISOString());
      const blocks = listAllBlocks().filter((b) => new Date(b.end_at) > start && new Date(b.start_at) < end);
      const pending = listBookings("pending").concat(listBookings("approved"));

      const stillFree = isSlotStillAvailable({ start, end, rules, events, blocks, pendingBookings: pending });
      if (!stillFree) {
        return { error: "Slot no longer available" } as const;
      }

      const booking = createBooking({
        link_id: link.id,
        name: String(body.name).slice(0, 120),
        requester_email: String(body.email).slice(0, 200),
        requester_phone: body.phone ? String(body.phone).slice(0, 40) : null,
        message: body.message ? String(body.message).slice(0, 1000) : null,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        ip,
      });
      return { booking } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    const booking = result.booking;

    // Fire-and-forget notifications to the owner
    void Promise.allSettled([
      addNotification(
        `📥 Novo pedido de agendamento`,
        `${booking.name} (${booking.requester_email}) pediu ${link.title} em ${new Date(
          booking.start_at
        ).toLocaleString("pt-BR")}`,
        "info",
        `/calendar?bookings=pending`,
        { booking_id: booking.id }
      ),
      sendTelegramAlert(
        "",
        "",
        `<b>📥 Novo pedido de agendamento</b>\n\n<b>${booking.name}</b>\n✉️ ${booking.requester_email}\n🗓️ ${new Date(
          booking.start_at
        ).toLocaleString("pt-BR")}\n⏱️ ${link.duration_minutes} min — <i>${link.title}</i>${booking.message ? `\n\n💬 ${booking.message}` : ""}\n\nAprove ou rejeite em /calendar.`
      ),
    ]);

    return NextResponse.json(
      {
        success: true,
        booking_id: booking.id,
        status: booking.status,
        message: "Pedido enviado. Você receberá um aviso quando for confirmado.",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Public booking failed:", error);
    return NextResponse.json({ error: "Failed to create booking" }, { status: 500 });
  }
}
