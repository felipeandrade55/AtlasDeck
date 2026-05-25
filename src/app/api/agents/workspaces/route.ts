/**
 * GET /api/agents/workspaces
 *
 * Lists every directory under `${OPENCLAW_DIR}/workspace`, annotated with:
 *  - which agent (if any) currently uses it
 *  - file count, byte size, last modified
 *  - quick flags for memory/skills/sessions/auth presence
 *
 * Used by the agent-edit modal to surface orphan workspaces (with data
 * but no agent pointing at them) so the user can import them with 1 click.
 */
import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { listOpenclawWorkspaces, resolveWorkspacePath } from "@/lib/workspace-migration";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    let agentsList: Array<{ id?: string; workspace?: string }> = [];
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      agentsList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    } catch {
      // Empty / missing config — just list folders
    }

    const workspaces = listOpenclawWorkspaces(agentsList);
    return NextResponse.json(
      {
        workspaces: workspaces.map((w) => ({
          relativePath: w.relativePath,
          absolutePath: w.absolutePath,
          folderName: w.folderName,
          ownerAgentId: w.ownerAgentId,
          stats: w.stats,
        })),
        agents: agentsList.map((a) => ({
          id: a.id,
          workspace: a.workspace,
          workspaceAbs: a.workspace ? resolveWorkspacePath(a.workspace) : null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
