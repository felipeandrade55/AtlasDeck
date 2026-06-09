import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";
import { getAllAgentMeta } from "@/lib/agents-meta";
import { refreshAllOrchestrators } from "@/lib/orchestrator-injector";

export const dynamic = "force-dynamic";

/**
 * Per-agent squad toggle. Adds or removes a single agent from EVERY
 * orchestrator's `allowAgents` in one call, so the user can selectively
 * include/exclude a specialist from Jarvis's delegation pool with one
 * click on its card — without hand-editing the main agent.
 *
 * Body: { agentId: string, linked: boolean }
 *   linked=true  → agent becomes delegable from all orchestrators
 *   linked=false → agent is removed from all orchestrators' allowAgents
 *
 * Orchestrators themselves can't be added as their own sub-agent.
 * Non-destructive: only touches allowAgents; never deletes agents/meta.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const linked = !!body?.linked;
    if (!agentId) {
      return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
    }

    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const meta = getAllAgentMeta();
    const roleOf = (id: string): string =>
      meta[id]?.role ?? (id === "main" || id === "jarvis" ? "orchestrator" : "specialist");

    const target = config.agents.list.find((a: any) => a.id === agentId);
    if (!target) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    if (roleOf(agentId) === "orchestrator") {
      return NextResponse.json(
        { error: "Um orquestrador não pode ser sub-agente de si mesmo." },
        { status: 400 },
      );
    }

    let changed = 0;
    for (const a of config.agents.list) {
      if (roleOf(a.id) !== "orchestrator" || a.id === agentId) continue;
      if (!a.subagents) a.subagents = { allowAgents: [] };
      if (!Array.isArray(a.subagents.allowAgents)) a.subagents.allowAgents = [];
      const has = a.subagents.allowAgents.includes(agentId);
      if (linked && !has) {
        a.subagents.allowAgents.push(agentId);
        changed++;
      } else if (!linked && has) {
        a.subagents.allowAgents = a.subagents.allowAgents.filter((id: string) => id !== agentId);
        changed++;
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    try {
      const peers = config.agents.list.map((a: any) => ({
        id: a.id,
        name: a.name,
        workspace: a.workspace,
        role: roleOf(a.id),
        specialty: meta[a.id]?.specialty ?? [],
        briefing_checklist: meta[a.id]?.briefing_checklist ?? [],
      }));
      await refreshAllOrchestrators(peers);
    } catch (e) {
      console.warn("[squad-link] refreshAllOrchestrators failed:", e);
    }

    try {
      logActivity(
        "agent",
        `${linked ? "Adicionado ao" : "Removido do"} squad do Jarvis: ${target.name ?? agentId}`,
        "success",
        { agent: agentId, metadata: { linked } },
      );
    } catch {}

    return NextResponse.json({ success: true, agentId, linked, changed });
  } catch (error: any) {
    console.error("[squad-link] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
