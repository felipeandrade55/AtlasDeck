import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getAllAgentMeta } from "@/lib/agents-meta";
import { refreshAllOrchestrators } from "@/lib/orchestrator-injector";

export const dynamic = "force-dynamic";

/**
 * Regenerates the orchestrator block inside every orchestrator-role
 * agent's MEMORY.md. Triggered manually from the UI or by a future cron
 * after task state changes.
 */
export async function POST() {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      agents?: { list?: Array<{ id: string; name?: string; workspace?: string }> };
    };
    const list = config.agents?.list ?? [];
    const meta = getAllAgentMeta();

    const peers = list.map((a) => ({
      id: a.id,
      name: a.name,
      workspace: a.workspace,
      role: meta[a.id]?.role ?? (a.id === "main" || a.id === "jarvis" ? "orchestrator" : "specialist"),
      specialty: meta[a.id]?.specialty ?? [],
    }));

    const results = await refreshAllOrchestrators(peers);
    return NextResponse.json({
      refreshed: results.length,
      results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
