/**
 * POST /api/openclaw/memory-mcp/install
 *   body: { agentId?: string, dryRun?: boolean }
 *
 * Registers (or refreshes) the atlasdeck-memory MCP server entry in
 * ~/.openclaw/mcp.json. Idempotent — re-running is safe and a no-op
 * when the entry already matches.
 *
 * DELETE /api/openclaw/memory-mcp/install
 *   Removes only the atlasdeck-memory entry; leaves other servers
 *   in the same file untouched.
 *
 * After install, OpenClaw must reload its MCP servers (restart the
 * gateway or send the reload signal) before the new tools are
 * exposed to the agent. That's not done from here — surface that
 * step in the UI.
 */
import { NextResponse } from "next/server";
import {
  buildExpectedConfig,
  installMcpServer,
  uninstallMcpServer,
} from "@/lib/openclaw-mcp-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InstallBody {
  agentId?: string;
  dryRun?: boolean;
}

export async function POST(request: Request) {
  let body: InstallBody = {};
  try {
    body = (await request.json()) as InstallBody;
  } catch {
    // empty body is fine — use defaults
  }

  const atlasdeckRoot = process.cwd();
  const agentId = body.agentId || "main";

  if (body.dryRun) {
    const expected = buildExpectedConfig({ atlasdeckRoot, agentId });
    return NextResponse.json({
      dryRun: true,
      wouldWriteTo: expected.path,
      entry: { [expected.serverName]: expected.entry },
    });
  }

  try {
    const result = installMcpServer({ atlasdeckRoot, agentId });
    return NextResponse.json({
      ok: true,
      ...result,
      reloadHint:
        "Restart the OpenClaw gateway (or send its reload signal) so the new MCP tools become visible to the agent.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const result = uninstallMcpServer();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
