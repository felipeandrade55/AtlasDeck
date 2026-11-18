/**
 * POST /api/memory/turn-capture — called by the atlasdeck-bridge plugin
 * (agent_end) after each eligible turn. Stores the turn in chats.db; the
 * extractor learns from it once the conversation settles (≥90s idle).
 *
 * Body: { sessionKey, sessionId?, agentId?, channel?, senderId?, turnId?, success?, user, assistant? }
 */
import { NextRequest, NextResponse } from "next/server";
import { isMemoryApiAuthorized } from "@/lib/memory-api-auth";
import { ingestCapturedTurn } from "@/lib/turn-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export async function POST(request: NextRequest) {
  if (!isMemoryApiAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const sessionKey = str(body.sessionKey, 300);
  const user = str(body.user, 20_000);
  if (!sessionKey || !user) {
    return NextResponse.json({ error: "sessionKey and user required" }, { status: 400 });
  }
  const channel = (str(body.channel, 40) || "").toLowerCase();
  if (channel === "whatsapp" && process.env.ATLAS_MEMORY_WHATSAPP !== "1") {
    return NextResponse.json({ stored: false, reason: "channel not allowed" });
  }
  try {
    const result = ingestCapturedTurn({
      sessionKey,
      sessionId: str(body.sessionId, 200),
      agentId: str(body.agentId, 120),
      channel: channel || null,
      senderId: str(body.senderId, 120),
      turnId: str(body.turnId, 200),
      success: body.success !== false,
      user,
      assistant: str(body.assistant, 20_000),
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
