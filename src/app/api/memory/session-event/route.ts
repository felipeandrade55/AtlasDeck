/**
 * POST /api/memory/session-event — called by the atlasdeck-bridge plugin
 * when a gateway session ends (reset, /new, idle, compaction…).
 *
 * A session ending is the best moment to learn from it: we kick an
 * extraction for that conversation right away (still subject to the
 * "agent busy" guard, so it never competes with the user's next message).
 *
 * Body: { sessionKey, sessionId?, agentId?, reason? }
 */
import { NextRequest, NextResponse } from "next/server";
import { isMemoryApiAuthorized } from "@/lib/memory-api-auth";
import { getThreadBySource } from "@/lib/chat-db";
import { extractRecentConversations } from "@/lib/memory-extractor";
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
    return NextResponse.json({ ok: false });
  }
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
  const thread = sessionKey ? getThreadBySource("telegram", sessionKey) : null;
  if (!thread) return NextResponse.json({ ok: true, queued: false });

  // Fire-and-forget: the plugin must not wait on an LLM call.
  void extractRecentConversations({ threadIds: [thread.id], idleMs: 0, maxBatches: 4 }).catch((err) =>
    console.warn("[memory/session-event] extraction failed:", err instanceof Error ? err.message : err),
  );
  return NextResponse.json({ ok: true, queued: true, threadId: thread.id, reason: body.reason ?? null });
}
