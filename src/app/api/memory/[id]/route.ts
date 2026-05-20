import { NextRequest, NextResponse } from "next/server";
import {
  deleteMemory,
  getLinksFor,
  getMemoryById,
  recordAccess,
  setMemoryEmbedding,
  updateMemory,
} from "@/lib/memory-db";
import { embedTexts } from "@/lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const memory = getMemoryById(id);
  if (!memory) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  recordAccess(id);
  const links = getLinksFor(id);
  return NextResponse.json({ memory, links });
}

export async function PATCH(
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

  const patch: Parameters<typeof updateMemory>[1] = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.content === "string") patch.content = body.content.trim();
  if (typeof body.summary === "string" || body.summary === null) {
    patch.summary = body.summary as string | null;
  }
  if (Array.isArray(body.tags)) {
    patch.tags = (body.tags as unknown[]).map(String);
  }
  if (typeof body.importance === "number") {
    patch.importance = Math.min(1, Math.max(0, body.importance));
  }
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (typeof body.language === "string" || body.language === null) {
    patch.language = body.language as string | null;
  }

  const before = getMemoryById(id);
  if (!before) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = updateMemory(id, patch);
  if (!updated) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  const contentChanged =
    patch.content !== undefined && patch.content !== before.content;
  const titleChanged =
    patch.title !== undefined && patch.title !== before.title;
  if (contentChanged || titleChanged) {
    try {
      const { vectors, provider } = await embedTexts([
        `${updated.title}\n${updated.content}`,
      ]);
      setMemoryEmbedding(
        id,
        vectors[0],
        `${provider.id}:${provider.modelId}`,
        provider.dim,
      );
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory/PATCH] re-embed failed:", err);
      }
    }
  }

  return NextResponse.json({ memory: getMemoryById(id) });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const ok = deleteMemory(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
