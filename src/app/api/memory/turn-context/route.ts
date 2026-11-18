/**
 * POST /api/memory/turn-context — called by the atlasdeck-bridge plugin
 * (before_prompt_build) on every eligible user turn in the gateway.
 *
 * Body: { message, sessionKey, sessionId?, agentId?, channel?, continuityState? }
 * Returns: { prependContext: string } — empty when nothing is relevant.
 *
 * Hard budget well under the plugin's timeout; any failure returns an
 * empty context so the turn proceeds normally.
 */
import { NextRequest, NextResponse } from "next/server";
import { isMemoryApiAuthorized } from "@/lib/memory-api-auth";
import { buildTurnContextSafe } from "@/lib/turn-context";
import { markBridgeSeen } from "@/lib/turn-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isMemoryApiAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  markBridgeSeen();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ prependContext: "" });
  }
  const message = typeof body.message === "string" ? body.message : "";
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.slice(0, 300) : "";
  if (!message || !sessionKey) return NextResponse.json({ prependContext: "" });

  // Defense in depth: never serve the owner's memories into third-party
  // channels even if the plugin is misconfigured.
  const channel = typeof body.channel === "string" ? body.channel.toLowerCase() : "";
  if (channel === "whatsapp" && process.env.ATLAS_MEMORY_WHATSAPP !== "1") {
    return NextResponse.json({ prependContext: "" });
  }

  const result = await buildTurnContextSafe(
    {
      message,
      sessionKey,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      agentId: typeof body.agentId === "string" ? body.agentId : "main",
      channel: channel || null,
      isNewSession: body.continuityState === "invalidated" ? true : undefined,
    },
    1_800,
  );
  return NextResponse.json({
    prependContext: result?.block ?? "",
    memories: result?.memoryIds.length ?? 0,
    newSession: result?.isNewSession ?? false,
    tookMs: result?.tookMs ?? null,
  });
}
