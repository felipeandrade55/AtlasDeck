/**
 * Manual extraction trigger.
 * POST /api/memory/extract/run
 * Body (optional): { maxSessions?, useLLM?, batchExchanges? }
 */
import { NextRequest, NextResponse } from "next/server";
import { extractRecentSessions } from "@/lib/memory-extractor";
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

  const maxSessions = Math.min(
    Math.max(Number(body.maxSessions) || 20, 1),
    100,
  );
  const batchExchanges = Math.min(
    Math.max(Number(body.batchExchanges) || 6, 1),
    50,
  );
  const useLLM = body.useLLM === undefined ? true : Boolean(body.useLLM);

  const startedAt = Date.now();
  try {
    const result = await extractRecentSessions({
      maxSessions,
      batchExchanges,
      useLLM,
    });
    try {
      const r = result as { extracted?: number; linked?: number; sessionsProcessed?: number; errors?: number };
      const extracted = r.extracted ?? 0;
      logActivity(
        "memory",
        extracted > 0
          ? `Extração de memória: ${extracted} nova(s) memória(s) de ${r.sessionsProcessed ?? 0} sessão(ões) (${useLLM ? "LLM" : "regras"})`
          : `Extração de memória: nada novo a extrair`,
        r.errors && r.errors > 0 ? "error" : "success",
        {
          duration_ms: Date.now() - startedAt,
          metadata: { maxSessions, batchExchanges, useLLM, extracted, linked: r.linked, errors: r.errors },
        }
      );
    } catch {}
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    try {
      logActivity("memory", `Extração de memória falhou`, "error", {
        duration_ms: Date.now() - startedAt,
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {}
    console.error("[memory/extract/run] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Extraction failed" },
      { status: 500 },
    );
  }
}
