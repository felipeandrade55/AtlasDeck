/**
 * GET    /api/chat/threads/:id  -> thread + messages
 * PATCH  /api/chat/threads/:id  -> rename, pin, archive, change agent
 * DELETE /api/chat/threads/:id  -> remove thread and its messages
 */
import { NextRequest, NextResponse } from "next/server";
import {
  deleteThread,
  getThread,
  listMessages,
  updateThread,
} from "@/lib/chat-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  const messages = listMessages({ threadId: id, limit: 2000 });
  return NextResponse.json({ thread, messages });
}

interface PatchBody {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const updated = updateThread(id, body);
  if (!updated) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return NextResponse.json({ thread: updated });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteThread(id);
  if (!ok) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
