/**
 * Briefing log for WhatsApp "modo Assessor".
 *
 *   POST → agent calls this after each handled conversation to record
 *          who talked, summary, urgency, action taken.
 *   GET  → Felipe (via UI or via agent calling on his behalf) pulls
 *          the structured briefing. Filters by since/sender/urgency/
 *          onlyPending.
 *   DELETE / PATCH /ack → mark entries as "Felipe already saw it".
 *
 * Designed to be called from BOTH directions:
 *   - From the agent over the gateway (via the briefing MCP tools the
 *     scripts/atlasdeck-memory-mcp.mts server exposes).
 *   - From the AtlasDeck UI (planned briefing card on the WhatsApp
 *     modal showing pending counts + last entries).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  logBriefing,
  listBriefings,
  acknowledgeAllBriefings,
  summarizeBriefings,
  type BriefingUrgency,
} from "@/lib/whatsapp-briefing-db";

export const dynamic = "force-dynamic";

const URGENCIES: BriefingUrgency[] = ["low", "normal", "medium", "high", "urgent"];

export async function POST(req: NextRequest) {
  let body: {
    accountId?: string;
    senderJid?: string;
    senderName?: string | null;
    summary?: string;
    urgency?: string;
    actionTaken?: string | null;
    requiresFollowup?: boolean;
    rawExcerpt?: string | null;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const accountId = (body.accountId || "main").trim();
  const senderJid = (body.senderJid || "").trim();
  const summary = (body.summary || "").trim();

  if (!senderJid) return NextResponse.json({ error: "senderJid obrigatório" }, { status: 400 });
  if (!summary) return NextResponse.json({ error: "summary obrigatório" }, { status: 400 });

  const urgency: BriefingUrgency = URGENCIES.includes(body.urgency as BriefingUrgency)
    ? (body.urgency as BriefingUrgency)
    : "normal";

  try {
    const entry = logBriefing({
      accountId,
      senderJid,
      senderName: body.senderName ?? null,
      summary,
      urgency,
      actionTaken: body.actionTaken ?? null,
      requiresFollowup: !!body.requiresFollowup,
      rawExcerpt: body.rawExcerpt ?? null,
    });
    return NextResponse.json({ ok: true, entry });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId") || undefined;
  const sinceParam = url.searchParams.get("sinceMs");
  const senderJid = url.searchParams.get("senderJid") || undefined;
  const urgencyParam = url.searchParams.get("urgency");
  const onlyPending = url.searchParams.get("onlyPending") === "1";
  const limit = Number(url.searchParams.get("limit") || 100);
  const includeSummary = url.searchParams.get("summary") === "1";

  const sinceMs = sinceParam ? Number(sinceParam) : undefined;
  const urgency = URGENCIES.includes(urgencyParam as BriefingUrgency)
    ? (urgencyParam as BriefingUrgency)
    : undefined;

  try {
    const entries = listBriefings({
      accountId,
      sinceMs,
      senderJid,
      urgency,
      onlyPending,
      limit,
    });
    const out: Record<string, unknown> = { ok: true, entries, count: entries.length };
    if (includeSummary) {
      out.summary = summarizeBriefings(accountId);
    }
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * PATCH = mark briefings as acknowledged (Felipe saw them).
 *   Body: { ids?: string[], accountId?: string, all?: boolean }
 *   If `all` is true, ack everything for the account (or globally when
 *   accountId is omitted). Otherwise ack each id passed.
 */
export async function PATCH(req: NextRequest) {
  let body: { ids?: string[]; accountId?: string; all?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  try {
    let acked = 0;
    if (body.all) {
      acked = acknowledgeAllBriefings(body.accountId);
    } else if (Array.isArray(body.ids)) {
      const { acknowledgeBriefing } = await import("@/lib/whatsapp-briefing-db");
      for (const id of body.ids) {
        if (typeof id === "string" && acknowledgeBriefing(id)) acked += 1;
      }
    } else {
      return NextResponse.json(
        { error: "Passe { all: true } OU { ids: [...] }" },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, acknowledged: acked });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
