import { NextRequest, NextResponse } from "next/server";
import { hasValidServiceToken } from "@/lib/openclaw-auth";
import { listBlocksInRange } from "@/lib/calendar-db";
import { createBlockWithConflicts } from "@/lib/calendar-blocks";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    if (!fromParam || !toParam) {
      return NextResponse.json({ error: "Missing from/to" }, { status: 400 });
    }
    const blocks = listBlocksInRange(fromParam, toParam);
    return NextResponse.json({ blocks });
  } catch (error) {
    console.error("Failed to list blocks:", error);
    return NextResponse.json({ error: "Failed to list blocks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.start_at || !body.end_at) {
      return NextResponse.json({ error: "Missing start_at/end_at" }, { status: 400 });
    }
    const start = new Date(body.start_at);
    const end = new Date(body.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return NextResponse.json({ error: "Invalid datetimes" }, { status: 400 });
    }

    const source = hasValidServiceToken(request) ? "openclaw" : "ui";
    const result = createBlockWithConflicts({
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: !!body.all_day,
      title: body.title ?? null,
      reason: body.reason ?? null,
      source,
    });

    try {
      const when = `${start.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} → ${end.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
      logActivity(
        "calendar",
        result.conflicts.length > 0
          ? `Bloqueio criado: ${when} — ${result.conflicts.length} compromisso(s) a remarcar`
          : `Bloqueio criado: ${when}`,
        result.conflicts.length > 0 ? "pending" : "success",
        {
          agent: source,
          metadata: { blockId: result.block.id, conflicts: result.conflicts.length },
        }
      );
    } catch {}

    void Promise.allSettled([
      addNotification(
        `🚫 Agenda bloqueada${result.conflicts.length > 0 ? ` (${result.conflicts.length} a remarcar)` : ""}`,
        `De ${start.toLocaleString("pt-BR")} até ${end.toLocaleString("pt-BR")}${result.conflicts.length > 0 ? " — abra o painel \"A remarcar\"." : ""}`,
        result.conflicts.length > 0 ? "warning" : "info",
        "/calendar",
        { block_id: result.block.id }
      ),
      result.conflicts.length > 0
        ? sendTelegramAlert(
            "",
            "",
            `<b>🚫 Bloqueio criado</b>\n\nDe ${start.toLocaleString("pt-BR")} até ${end.toLocaleString(
              "pt-BR"
            )}\n\n⚠️ <b>${result.conflicts.length}</b> compromisso${result.conflicts.length > 1 ? "s" : ""} caíram nesse intervalo e precisam ser remarcados. Abra <code>/calendar</code> ou peça pro OpenClaw.`
          )
        : null,
    ]);

    return NextResponse.json(
      {
        block: result.block,
        conflicts: result.conflicts.length,
        truncated: result.truncated,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to create block:", error);
    return NextResponse.json({ error: "Failed to create block" }, { status: 500 });
  }
}
