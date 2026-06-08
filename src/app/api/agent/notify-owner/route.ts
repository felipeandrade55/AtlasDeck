import { NextRequest, NextResponse } from "next/server";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Urgent "ping the owner" endpoint, used by the WhatsApp Assessor (Jarvis) so
 * that when it tells a contact "vou tentar contato com o Felipe agora" the
 * promise is actually kept: it fires a Telegram alert to Felipe AND drops a
 * notification on the dashboard bell, immediately.
 *
 * Called by the `notify_owner` MCP tool. Best-effort on both channels — we
 * report which ones succeeded so the agent can be honest about it.
 */
type Urgency = "normal" | "high" | "urgent";

const URGENCY_EMOJI: Record<Urgency, string> = {
  normal: "🔔",
  high: "🟠",
  urgent: "🔴",
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const message: string = String(body?.message ?? "").trim();
    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const urgency: Urgency = ["normal", "high", "urgent"].includes(body?.urgency)
      ? (body.urgency as Urgency)
      : "high";
    const fromName: string = String(body?.fromName ?? "").trim();
    const fromContext = fromName ? ` de ${fromName}` : "";
    const emoji = URGENCY_EMOJI[urgency];
    const title = `${emoji} Recado urgente${fromContext} (via assessor WhatsApp)`;

    const telegramText =
      `<b>${emoji} Recado urgente — assessor WhatsApp</b>\n\n` +
      (fromName ? `<b>De:</b> ${fromName}\n` : "") +
      `<b>Urgência:</b> ${urgency}\n\n` +
      `${message}`;

    const [notifResult, tgResult] = await Promise.allSettled([
      addNotification(
        title,
        message,
        urgency === "normal" ? "info" : "warning",
        "/whatsapp/briefing",
        { source: "whatsapp-assessor", urgency, fromName: fromName || null }
      ),
      sendTelegramAlert("", "", telegramText),
    ]);

    const dashboard = notifResult.status === "fulfilled";
    const telegram = tgResult.status === "fulfilled" && tgResult.value === true;

    return NextResponse.json({
      ok: dashboard || telegram,
      channels: { dashboard, telegram },
    });
  } catch (error) {
    console.error("notify-owner failed:", error);
    return NextResponse.json({ error: "Failed to notify owner" }, { status: 500 });
  }
}
