/**
 * GET /api/openclaw/memory-mcp/diagnose?agentId=main
 *
 * Full self-check chain — read mcp.json, validate paths, smoke-spawn
 * the MCP child for up to 6s, capture its stderr. Returns a flat list
 * of checks the UI renders inline with the existing doctor idiom.
 *
 * Side-effect free except for the child spawn, which is killed on
 * exit. Safe to call on demand from a button.
 */
import { NextResponse } from "next/server";
import { diagnoseMemoryMcp } from "@/lib/memory-mcp-diagnose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") || "main";
  const report = await diagnoseMemoryMcp({ agentId });
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
