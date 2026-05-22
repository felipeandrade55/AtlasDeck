/**
 * GET  /api/chat/threads        -> list threads (newest first, pinned first)
 * POST /api/chat/threads        -> create an empty thread
 */
import { NextRequest, NextResponse } from "next/server";
import { createThread, listThreads, getThreadStats } from "@/lib/chat-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const search = url.searchParams.get("q") ?? undefined;
  const archivedParam = url.searchParams.get("archived");
  const pinnedParam = url.searchParams.get("pinned");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");

  const threads = listThreads({
    agentId,
    search,
    archived: archivedParam === null ? undefined : archivedParam === "1" || archivedParam === "true",
    pinned: pinnedParam === null ? undefined : pinnedParam === "1" || pinnedParam === "true",
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });

  return NextResponse.json({
    threads,
    stats: getThreadStats(),
  });
}

interface CreateBody {
  agentId?: string;
  title?: string;
  workspace?: string | null;
  metadata?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const agentId = body.agentId?.trim() || "main";
  const thread = createThread({
    agent_id: agentId,
    title: body.title?.trim() || undefined,
    workspace: body.workspace ?? null,
    source: "web",
    metadata: body.metadata ?? {},
  });

  return NextResponse.json({ thread });
}
