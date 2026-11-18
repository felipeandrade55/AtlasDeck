/**
 * POST /api/memory/turn-reply — called by the atlasdeck-bridge plugin on
 * `message_sent`: the reply text actually delivered to the channel.
 * Needed because on Telegram the reply goes out through the `message`
 * tool and is missing from agent_end's message snapshot.
 *
 * Body: { sessionKey, content, success? }
 */
import { NextRequest, NextResponse } from "next/server";
import { isMemoryApiAuthorized } from "@/lib/memory-api-auth";
import { ingestDeliveredReply } from "@/lib/turn-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isMemoryApiAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ status: "ignored" });
  }
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.slice(0, 300) : "";
  const content = typeof body.content === "string" ? body.content.slice(0, 20_000) : "";
  if (!sessionKey || !content || body.success === false) return NextResponse.json({ status: "ignored" });
  // Only conversations the bridge is allowed to capture (Telegram by default).
  if (/:whatsapp:/i.test(sessionKey) && process.env.ATLAS_MEMORY_WHATSAPP !== "1") {
    return NextResponse.json({ status: "ignored" });
  }
  return NextResponse.json(ingestDeliveredReply({ sessionKey, content }));
}
