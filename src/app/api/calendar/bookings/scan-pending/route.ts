import { NextRequest, NextResponse } from "next/server";
import { listBookings } from "@/lib/calendar-db";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NUDGE_AFTER_MS = 30 * 60 * 1000;

export async function POST(_request: NextRequest) {
  try {
    const pending = listBookings("pending");
    const now = Date.now();
    const stale = pending.filter((b) => now - new Date(b.created_at).getTime() >= NUDGE_AFTER_MS);

    for (const b of stale) {
      void Promise.allSettled([
        addNotification(
          "⏳ Pedido aguardando há mais de 30 min",
          `${b.name} (${b.requester_email}) — ${new Date(b.start_at).toLocaleString("pt-BR")}`,
          "warning",
          "/calendar?bookings=pending",
          { booking_id: b.id }
        ),
        sendTelegramAlert(
          "",
          "",
          `<b>⏳ Pedido pendente</b>\n\n<b>${b.name}</b> está esperando há mais de 30 minutos.\n🗓️ ${new Date(
            b.start_at
          ).toLocaleString("pt-BR")}\n\nAprove em /calendar.`
        ),
      ]);
    }

    return NextResponse.json({ nudged: stale.length });
  } catch (error) {
    console.error("scan-pending failed:", error);
    return NextResponse.json({ error: "Failed to scan pending bookings" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
