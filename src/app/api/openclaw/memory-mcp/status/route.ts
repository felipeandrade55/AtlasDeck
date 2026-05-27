/**
 * GET /api/openclaw/memory-mcp/status
 *
 * Inspects ~/.openclaw/mcp.json (where OpenClaw looks for MCP server
 * definitions) and reports whether the atlasdeck-memory server is
 * registered there. Also surfaces a divergence flag when the entry
 * exists but doesn't match what we'd write today (e.g. ATLASDECK_ROOT
 * changed because the checkout moved).
 *
 * Side-effect free — safe to poll from the UI.
 */
import { NextResponse } from "next/server";
import { inspectStatus } from "@/lib/openclaw-mcp-config";
import { listMemories } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") || "main";

  const status = inspectStatus({
    atlasdeckRoot: process.cwd(),
    agentId,
  });

  // How many memories has the agent actually saved via the tool?
  // This is the canonical signal that the wiring works end-to-end —
  // the registration could be present but never invoked.
  const { total: agentSavedCount } = listMemories({
    source: "agent",
    limit: 1,
  });

  return NextResponse.json(
    {
      ...status,
      agentSavedCount,
      atlasdeckRoot: process.cwd(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
