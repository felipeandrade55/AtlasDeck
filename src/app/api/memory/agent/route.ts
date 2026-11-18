/**
 * Memory operations for agents (the atlasdeck-memory MCP server).
 *
 * POST /api/memory/agent
 *   { action: "add",    workspace, agent_id, type, title, content, importance?, tags?, summary?, pinned?, language? }
 *   { action: "search", workspace, query, k?, type? }
 *   { action: "update", id, title?, content?, summary?, importance?, tags?, pinned?, archived? }
 *
 * Why over HTTP: the MCP server is a separate process spawned by the
 * gateway. When it embedded locally it loaded a second copy of the
 * embedding model (RAM on a box that has been OOM-killed before) and
 * skipped the dedupe/hybrid search logic. Now there is one copy, here.
 *
 * Public at the edge (no admin cookie in the MCP process); self-protected
 * with the gateway service token or the admin cookie.
 */
import { NextRequest, NextResponse } from "next/server";
import { isMemoryApiAuthorized as isAuthorized } from "@/lib/memory-api-auth";
import { addMemory, patchMemory, searchHybrid } from "@/lib/memory-service";
import { recordAccess, type MemoryRow, type MemoryType } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: MemoryType[] = ["episodic", "semantic", "procedural", "identity"];

function view(row: MemoryRow, contentChars = 400) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content.length > contentChars ? `${row.content.slice(0, contentChars - 1)}…` : row.content,
    importance: row.importance,
    tags: row.tags,
    pinned: row.pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action = body.action;

  try {
    if (action === "add") {
      const type = TYPES.includes(body.type as MemoryType) ? (body.type as MemoryType) : "semantic";
      const title = str(body.title, 200);
      const content = str(body.content, 4000);
      if (!title || !content) return NextResponse.json({ error: "title and content required" }, { status: 400 });
      const result = await addMemory({
        workspace: str(body.workspace, 120) || "workspace",
        agent_id: str(body.agent_id, 120) || "main",
        type,
        title,
        content,
        summary: str(body.summary, 280) || null,
        source: "agent",
        tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 12) : undefined,
        importance: typeof body.importance === "number" ? Math.min(1, Math.max(0, body.importance)) : 0.7,
        pinned: body.pinned === true,
        language: str(body.language, 12) || null,
      });
      return NextResponse.json({ ok: true, action: result.action, memory: view(result.memory) });
    }

    if (action === "search") {
      const query = str(body.query, 500);
      if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });
      const type = TYPES.includes(body.type as MemoryType) ? (body.type as MemoryType) : undefined;
      const k = Math.min(Math.max(Number(body.k) || 8, 1), 20);
      const hits = await searchHybrid(query, { workspace: str(body.workspace, 120) || undefined, type, k });
      for (const h of hits) recordAccess(h.memory.id);
      return NextResponse.json({
        mode: "hybrid",
        hits: hits.map((h) => ({
          score: Number(h.score.toFixed(5)),
          similarity: h.cosine === null ? null : Number(h.cosine.toFixed(4)),
          memory: view(h.memory),
        })),
      });
    }

    if (action === "update") {
      const id = str(body.id, 80);
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const row = await patchMemory(id, {
        title: body.title !== undefined ? str(body.title, 200) : undefined,
        content: body.content !== undefined ? str(body.content, 4000) : undefined,
        summary: body.summary !== undefined ? str(body.summary, 280) : undefined,
        importance: typeof body.importance === "number" ? Math.min(1, Math.max(0, body.importance)) : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 12) : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
      });
      if (!row) return NextResponse.json({ error: `memory ${id} not found` }, { status: 404 });
      return NextResponse.json({ ok: true, memory: view(row) });
    }

    return NextResponse.json({ error: `unknown action ${String(action)}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
