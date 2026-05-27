/**
 * GET /api/openclaw/health-check
 *
 * Read-only snapshot of "is the OpenClaw config wired up so chat
 * actually works?". Used by the chat page on load: when something
 * is misconfigured, we surface a friendly banner with a "Corrigir
 * automaticamente" button BEFORE the user hits the issue in a turn.
 *
 * No side effects — calling this 1000 times changes nothing.
 */
import { NextResponse } from "next/server";
import { checkOpenClawHealth } from "@/lib/openclaw-auto-fix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = checkOpenClawHealth();
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
