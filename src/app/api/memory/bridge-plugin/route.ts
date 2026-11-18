/**
 * Gateway memory bridge (atlasdeck-bridge OpenClaw plugin).
 *
 * GET  /api/memory/bridge-plugin                 → status
 * POST /api/memory/bridge-plugin { action: "install", channels?, ownerSenderIds?, restart? }
 * POST /api/memory/bridge-plugin { action: "disable", restart? }
 *
 * Admin-only (behind the dashboard cookie at the edge).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  disableBridgePlugin,
  getBridgeStatus,
  installBridgePlugin,
} from "@/lib/openclaw-plugin-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getBridgeStatus());
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  const restart = body.restart !== false;
  if (body.action === "install") {
    const channels = Array.isArray(body.channels) ? body.channels.map(String) : undefined;
    const ownerSenderIds = Array.isArray(body.ownerSenderIds) ? body.ownerSenderIds.map(String) : undefined;
    const result = await installBridgePlugin({ channels, ownerSenderIds, restart });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }
  if (body.action === "disable") {
    const result = await disableBridgePlugin({ restart });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }
  return NextResponse.json({ error: "action must be install | disable" }, { status: 400 });
}
