/**
 * Manual extraction trigger.
 * POST /api/memory/extract/run
 * Body (optional): { maxBatches?, threadIds?: string[] }
 *
 * Runs immediately (ignores the idle/busy guards the scheduler uses).
 */
import { NextRequest, NextResponse } from "next/server";
import { extractRecentConversations } from "@/lib/memory-extractor";
import { runEngineV2Migration } from "@/lib/memory-scheduler";
import { getOneShotStatus } from "@/lib/llm-oneshot";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // optional body
  }

  const maxBatches = Math.min(Math.max(Number(body.maxBatches) || 10, 1), 50);
  const threadIds = Array.isArray(body.threadIds) ? body.threadIds.map(String) : undefined;

  const startedAt = Date.now();
  try {
    await runEngineV2Migration();
    const result = await extractRecentConversations({ maxBatches, threadIds, force: true });
    const changed = result.created + result.updated + result.superseded;
    try {
      logActivity(
        "memory",
        changed > 0
          ? `Extração de memória: +${result.created} nova(s), ${result.updated} atualizada(s), ${result.superseded} substituída(s)`
          : result.failed > 0
            ? `Extração de memória falhou em ${result.failed} lote(s)`
            : `Extração de memória: nada novo a aprender`,
        result.failed > 0 ? "error" : "success",
        { duration_ms: Date.now() - startedAt, metadata: { ...result } },
      );
    } catch {}
    return NextResponse.json({ success: true, ...result, llm: getOneShotStatus() });
  } catch (err) {
    try {
      logActivity("memory", `Extração de memória falhou`, "error", {
        duration_ms: Date.now() - startedAt,
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {}
    console.error("[memory/extract/run] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Extraction failed", llm: getOneShotStatus() },
      { status: 500 },
    );
  }
}
