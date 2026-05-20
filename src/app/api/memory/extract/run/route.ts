/**
 * Manual extraction trigger.
 * POST /api/memory/extract/run
 * Body (optional): { maxSessions?, useLLM?, batchExchanges? }
 */
import { NextRequest, NextResponse } from "next/server";
import { extractRecentSessions } from "@/lib/memory-extractor";

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

  try {
    const result = await extractRecentSessions({
      maxSessions,
      batchExchanges,
      useLLM,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[memory/extract/run] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Extraction failed" },
      { status: 500 },
    );
  }
}
