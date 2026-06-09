import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { executeTool, type OrchestratorToolName } from "@/lib/orchestrator-tools";
import { hasValidServiceToken } from "@/lib/openclaw-auth";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getAllAgentMeta } from "@/lib/agents-meta";

export const dynamic = "force-dynamic";

const VALID: OrchestratorToolName[] = [
  "delegate_to",
  "decompose",
  "check_progress",
  "send_note",
  "review",
  "notify_user",
  "approve_task",
  "reject_task",
];

/**
 * Auth gate. This route is public at the middleware layer (so the MCP server,
 * which has no admin cookie, can reach it) but self-protects here:
 *   - a valid service token (gateway.auth.token / OPENCLAW_SERVICE_TOKEN), used
 *     by the atlasdeck-memory MCP server, OR
 *   - the admin cookie, used by the dashboard's "run tool manually" buttons.
 */
function isAuthorized(request: NextRequest): boolean {
  if (hasValidServiceToken(request)) return true;
  const cookie = request.cookies.get("mc_auth");
  if (cookie && process.env.AUTH_SECRET && cookie.value === process.env.AUTH_SECRET) {
    return true;
  }
  return false;
}

/**
 * GET → the specialist squad (id, name, role, specialty) so the orchestrator
 * can discover valid `agent_id`s from any channel. Backs the MCP `list_squad`
 * tool. Kept on this route so it shares the single service-token auth path.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      agents?: { list?: Array<{ id: string; name?: string }> };
    };
    const meta = getAllAgentMeta();
    const squad = (config.agents?.list ?? [])
      .filter((a) => a.id !== "main" && a.id !== "jarvis")
      .map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        role: meta[a.id]?.role ?? "specialist",
        specialty: meta[a.id]?.specialty ?? [],
      }));
    return NextResponse.json({ ok: true, count: squad.length, squad });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Generic dispatch endpoint for orchestrator tool calls. The atlasdeck-memory
 * MCP server (delegate_to / decompose / check_progress) and the chat-stream
 * text-protocol both POST here.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    const tool = body?.tool as OrchestratorToolName | undefined;
    if (!tool || !VALID.includes(tool)) {
      return NextResponse.json(
        { error: `tool must be one of: ${VALID.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await executeTool(tool, body.args ?? {});
    const httpStatus = result.ok ? 200 : 400;
    return NextResponse.json(result, { status: httpStatus });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
