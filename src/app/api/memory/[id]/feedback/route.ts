import { NextRequest, NextResponse } from "next/server";
import { getMemoryById, recordFeedback } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const voteRaw = body.vote;
  const vote: 1 | -1 | null =
    voteRaw === 1 || voteRaw === "1" || voteRaw === "up"
      ? 1
      : voteRaw === -1 || voteRaw === "-1" || voteRaw === "down"
      ? -1
      : null;
  if (!vote) {
    return NextResponse.json({ error: "Invalid vote" }, { status: 400 });
  }

  if (!getMemoryById(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const context_ = typeof body.context === "string" ? body.context : null;
  const query = typeof body.query === "string" ? body.query : null;
  recordFeedback(id, vote, context_, query);
  return NextResponse.json({ success: true, memory: getMemoryById(id) });
}
