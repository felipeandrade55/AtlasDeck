import { NextRequest, NextResponse } from "next/server";
import { getBookingLinkById } from "@/lib/calendar-db";
import { sendTelegramAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildBaseUrl(request: NextRequest): string {
  const envBase = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ?? process.env.ATLASDECK_BASE_URL)?.replace(/\/$/, "");
  if (envBase) return envBase;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.linkId) {
      return NextResponse.json({ error: "Missing linkId" }, { status: 400 });
    }
    const link = getBookingLinkById(body.linkId);
    if (!link) return NextResponse.json({ error: "Link not found" }, { status: 404 });

    const url = `${buildBaseUrl(request)}/book/${link.token}`;
    const customText = body.customText ? `${body.customText}\n\n` : "";
    const message = `${customText}<b>📅 ${link.title}</b>${
      link.description ? `\n${link.description}` : ""
    }\n⏱️ ${link.duration_minutes} minutos\n\nAgende um horário aqui:\n${url}`;

    const ok = await sendTelegramAlert(body.botToken ?? "", body.chatId ?? "", message);
    if (!ok) {
      return NextResponse.json({ error: "Telegram send failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true, url });
  } catch (error) {
    console.error("Failed to share booking link:", error);
    return NextResponse.json({ error: "Failed to share" }, { status: 500 });
  }
}
