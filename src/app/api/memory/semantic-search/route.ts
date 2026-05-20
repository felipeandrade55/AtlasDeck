/**
 * Semantic memory search.
 * GET /api/memory/semantic-search?q=<query>&workspace=<id>&k=<n>&type=<t>
 *
 * Embeds the query, runs cosine k-NN against the memories table, and
 * returns ranked hits. Distinct from /api/memory/search (which is the
 * keyword FTS5 endpoint over markdown files).
 */
import { NextRequest, NextResponse } from "next/server";
import { searchSimilar, type MemoryType } from "@/lib/memory-db";
import { embedTexts } from "@/lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 500;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("q") || "").trim();
  const workspace = searchParams.get("workspace") || undefined;
  const typeParam = searchParams.get("type");
  const k = Math.min(Math.max(parseInt(searchParams.get("k") || "10", 10), 1), 50);
  const minScore = parseFloat(searchParams.get("minScore") || "0");

  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `Query too long (max ${MAX_QUERY_LENGTH})` },
      { status: 400 },
    );
  }
  if (query.length < 2) {
    return NextResponse.json({ results: [], query });
  }

  const VALID_TYPES = new Set<MemoryType>([
    "episodic",
    "semantic",
    "procedural",
    "identity",
  ]);
  let type: MemoryType | MemoryType[] | undefined;
  if (typeParam) {
    const parts = typeParam.split(",").map((s) => s.trim()).filter(Boolean);
    const valid = parts.filter((p) => VALID_TYPES.has(p as MemoryType)) as MemoryType[];
    if (valid.length === 1) type = valid[0];
    else if (valid.length > 1) type = valid;
  }

  try {
    const { vectors } = await embedTexts([query]);
    const hits = searchSimilar(vectors[0], {
      workspace,
      type,
      k,
      minScore: Number.isFinite(minScore) ? minScore : 0,
    });
    return NextResponse.json({
      results: hits.map((h) => ({
        memory: h.memory,
        score: h.score,
      })),
      query,
      total: hits.length,
    });
  } catch (err) {
    console.error("[memory/semantic-search] failed:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Search failed",
        hint: "Embedding model may not be ready yet. Run 'npm run setup:memory' or hit POST /api/memory/setup-embeddings.",
      },
      { status: 503 },
    );
  }
}
