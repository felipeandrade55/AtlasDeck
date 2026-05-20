/**
 * Recall API — returns top-k memories for a query, formatted as a
 * prompt block ready to inject into a system prompt or AUTO_RECALL.md.
 *
 * POST /api/memory/recall
 * Body: { query, workspace?, agent?, k?, types?, excludeArchived? }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  listMemories,
  recordAccess,
  searchSimilar,
  type MemoryType,
} from "@/lib/memory-db";
import { embedTexts } from "@/lib/embeddings";
import { buildPromptBlock } from "@/lib/memory-extractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
  const agent = typeof body.agent === "string" ? body.agent : undefined;
  const k = Math.min(Math.max(Number(body.k) || 8, 1), 30);

  const VALID_TYPES = new Set<MemoryType>([
    "episodic",
    "semantic",
    "procedural",
    "identity",
  ]);
  let types: MemoryType[] | undefined;
  if (Array.isArray(body.types)) {
    types = (body.types as unknown[])
      .map(String)
      .filter((t): t is MemoryType => VALID_TYPES.has(t as MemoryType));
  }

  let semantic: ReturnType<typeof searchSimilar> = [];
  if (query.length >= 2) {
    try {
      const { vectors } = await embedTexts([query]);
      semantic = searchSimilar(vectors[0], {
        workspace,
        type: types,
        k: k * 2,
        minScore: 0.25,
      });
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory/recall] semantic search failed:", err);
      }
    }
  }

  // Always merge in identity + pinned (regardless of query) — those
  // are baseline context the agent should always see
  const pinned = listMemories({
    workspace,
    agent_id: agent,
    pinned: true,
    archived: false,
    limit: 10,
  }).memories;

  const identity = listMemories({
    workspace,
    agent_id: agent,
    type: "identity",
    archived: false,
    limit: 5,
    sort: "importance",
  }).memories;

  const seen = new Set<string>();
  const merged: typeof pinned = [];
  const pushUnique = (m: (typeof pinned)[number]) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    merged.push(m);
  };

  for (const m of identity) pushUnique(m);
  for (const m of pinned) pushUnique(m);
  for (const hit of semantic) pushUnique(hit.memory);

  const top = merged.slice(0, k);
  for (const m of top) recordAccess(m.id);

  const promptBlock = buildPromptBlock(top);

  return NextResponse.json({
    memories: top,
    scores: semantic.map((h) => ({ id: h.memory.id, score: h.score })),
    promptBlock,
    query,
  });
}
