/**
 * POST /api/openclaw/memory-mcp/activate
 *   body: { agentId?: string }
 *
 * One-button activation: install entry → restart OpenClaw → wait for
 * gateway → re-inspect status. Designed for a layperson clicking
 * "Ativar memória avançada" without knowing the underlying steps.
 *
 * Always returns 200 with a structured report — the UI inspects
 * `ok` + per-step results to decide what to show. We never throw
 * because every step has a meaningful "soft failure" mode (e.g.
 * restart strategy mismatched the actual process manager).
 */
import { NextResponse } from "next/server";
import { activateMemoryMcp } from "@/lib/memory-mcp-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActivateBody {
  agentId?: string;
  skipRestart?: boolean;
}

export async function POST(request: Request) {
  let body: ActivateBody = {};
  try {
    body = (await request.json()) as ActivateBody;
  } catch {
    // empty body is fine — use defaults
  }

  const result = await activateMemoryMcp({
    agentId: body.agentId,
    skipRestart: body.skipRestart,
  });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
