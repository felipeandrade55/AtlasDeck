/**
 * GET    /api/agents/memory-connect?agentId=<id>
 *          → detects custom memory resources (agent_memory.db,
 *            knowledge_base.json, skills/, sessions/) and tells whether
 *            the agent's instructions.md already has the appendix
 * POST   /api/agents/memory-connect
 *          body: { agentId: string }
 *          → builds + writes (or refreshes) the appendix into instructions.md
 *            and restarts the gateway is optional (frontend triggers separately)
 * DELETE /api/agents/memory-connect?agentId=<id>
 *          → removes the appendix block, leaves instructions.md otherwise intact
 *
 * All operations are idempotent and fence-marker based, so manually-edited
 * content outside the fences is preserved.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  detectAgentMemoryResources,
  attachMemoryAppendix,
  detachMemoryAppendix,
  buildMemoryAppendix,
} from "@/lib/agent-memory-resources";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

function getAgentIdOr400(req: NextRequest): { id: string } | NextResponse {
  const id = (req.nextUrl.searchParams.get("agentId") || "").trim();
  if (!id) {
    return NextResponse.json({ error: "agentId obrigatório" }, { status: 400 });
  }
  return { id };
}

export async function GET(req: NextRequest) {
  const got = getAgentIdOr400(req);
  if (got instanceof NextResponse) return got;
  try {
    const resources = detectAgentMemoryResources(got.id);
    const previewAppendix = resources.hasAnyResource
      ? buildMemoryAppendix(resources)
      : "";
    return NextResponse.json(
      { ...resources, previewAppendix, previewLines: previewAppendix.split("\n").length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { agentId?: string };
  try { body = await req.json(); } catch { body = {}; }
  const agentId = (body.agentId || "").trim();
  if (!agentId) {
    return NextResponse.json({ error: "agentId obrigatório" }, { status: 400 });
  }
  try {
    const result = attachMemoryAppendix(agentId);
    try {
      logActivity(
        "agent",
        result.refreshed
          ? `Apêndice de memória custom atualizado em ${agentId}/instructions.md`
          : `Apêndice de memória custom adicionado em ${agentId}/instructions.md`,
        "success",
        {
          agent: agentId,
          metadata: { path: result.path, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes },
        },
      );
    } catch {}
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const got = getAgentIdOr400(req);
  if (got instanceof NextResponse) return got;
  try {
    const result = detachMemoryAppendix(got.id);
    try {
      logActivity(
        "agent",
        `Apêndice de memória custom removido de ${got.id}/instructions.md`,
        result.ok ? "success" : "warning",
        { agent: got.id, metadata: { path: result.path, removedBytes: result.removedBytes } },
      );
    } catch {}
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
