/**
 * Re-learn past conversations with the v2 extractor.
 *
 * GET  /api/memory/backfill?days=90          → estimate + current state
 * POST /api/memory/backfill { action: "start", days? } | { action: "stop" }
 *
 * Runs in the background (scheduler), oldest first, only while the agent
 * is idle — it shares the owner's OpenClaw subscription with the bot.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  estimateBackfill,
  getBackfillState,
  startBackfill,
  stopBackfill,
} from "@/lib/memory-extractor";
import { runEngineV2Migration } from "@/lib/memory-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampDays(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 365) : 90;
}

export async function GET(request: NextRequest) {
  const days = clampDays(new URL(request.url).searchParams.get("days") ?? 90);
  await runEngineV2Migration();
  return NextResponse.json({ days, estimate: estimateBackfill(days), state: getBackfillState() });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  if (body.action === "start") {
    await runEngineV2Migration();
    return NextResponse.json({ ok: true, state: startBackfill(clampDays(body.days)) });
  }
  if (body.action === "stop") {
    return NextResponse.json({ ok: true, state: stopBackfill() });
  }
  return NextResponse.json({ error: "action must be start | stop" }, { status: 400 });
}
