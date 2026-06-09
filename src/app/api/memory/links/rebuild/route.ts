import { NextRequest, NextResponse } from "next/server";
import { rebuildAllLinks } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rebuild the automatic memory link graph (semantic + shared-tag edges).
 *
 * Backfills connections for the whole existing corpus — memories created
 * before auto-linking, or under the old too-strict threshold, were left
 * isolated. User/LLM-curated edges are preserved.
 *
 * Body (all optional):
 *   { workspace?, minScore?, k?, maxTagFanout? }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine — rebuild every workspace with defaults
  }

  const workspace =
    typeof body.workspace === "string" && body.workspace.trim()
      ? body.workspace.trim()
      : undefined;
  const minScore =
    typeof body.minScore === "number" ? body.minScore : undefined;
  const k = typeof body.k === "number" ? body.k : undefined;
  const maxTagFanout =
    typeof body.maxTagFanout === "number" ? body.maxTagFanout : undefined;

  try {
    const result = rebuildAllLinks({ workspace, minScore, k, maxTagFanout });

    try {
      logActivity(
        "memory",
        `Conexões reconstruídas: ${result.total} arestas em ${result.memories} memórias`,
        "success",
        {
          agent: "manual",
          metadata: { ...result, workspace: workspace ?? "all" },
        },
      );
    } catch {}

    return NextResponse.json(result);
  } catch (err) {
    console.error("[memory/links/rebuild] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Rebuild failed" },
      { status: 500 },
    );
  }
}
