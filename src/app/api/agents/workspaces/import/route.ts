/**
 * POST /api/agents/workspaces/import
 *
 * Body: {
 *   agentId: string,            // target agent
 *   sourceWorkspace: string,    // path as it appears in agent.workspace
 *                                  (e.g. "./workspace/mission-control")
 *   overwrite?: boolean         // default false (skip existing files)
 * }
 *
 * Resolves the agent's current workspace + the source workspace, both must
 * sit under OPENCLAW_DIR/workspace, and copies all files recursively.
 * Caller should restart the gateway afterwards (the dashboard does this via
 * restartGatewayClient).
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { importWorkspace, resolveWorkspacePath } from "@/lib/workspace-migration";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { agentId?: string; sourceWorkspace?: string; overwrite?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const agentId = (body.agentId || "").trim();
  const sourceWorkspace = (body.sourceWorkspace || "").trim();
  if (!agentId || !sourceWorkspace) {
    return NextResponse.json(
      { error: "Faltam parâmetros: agentId e sourceWorkspace" },
      { status: 400 },
    );
  }

  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const agent = list.find((a: { id?: string }) => a?.id === agentId);
    if (!agent) {
      return NextResponse.json({ error: `Agente "${agentId}" não encontrado` }, { status: 404 });
    }
    const targetWorkspace = typeof agent.workspace === "string" ? agent.workspace : "";
    if (!targetWorkspace) {
      return NextResponse.json(
        { error: `Agente "${agentId}" não tem campo workspace definido` },
        { status: 400 },
      );
    }

    const sourceAbs = resolveWorkspacePath(sourceWorkspace);
    const targetAbs = resolveWorkspacePath(targetWorkspace);

    if (sourceAbs === targetAbs) {
      return NextResponse.json(
        { error: "Origem e destino apontam pra mesma workspace — nada a importar" },
        { status: 400 },
      );
    }

    const result = importWorkspace(sourceAbs, targetAbs, { overwrite: !!body.overwrite });

    try {
      logActivity(
        "agent",
        `Workspace importada para "${agentId}": ${result.filesCopied} arquivos (${result.filesSkipped} já existiam)`,
        result.errors.length === 0 ? "success" : "warning",
        {
          agent: agentId,
          metadata: {
            source: sourceWorkspace,
            target: targetWorkspace,
            filesCopied: result.filesCopied,
            filesSkipped: result.filesSkipped,
            bytesCopied: result.bytesCopied,
            errors: result.errors.length,
            overwrite: !!body.overwrite,
          },
        },
      );
    } catch {}

    return NextResponse.json({
      success: true,
      agentId,
      source: { relative: sourceWorkspace, absolute: sourceAbs },
      target: { relative: targetWorkspace, absolute: targetAbs },
      ...result,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
