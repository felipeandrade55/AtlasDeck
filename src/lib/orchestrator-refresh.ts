/**
 * Shared helper to regenerate every orchestrator's MEMORY.md block from the
 * current OpenClaw agent config + AtlasDeck meta. Centralizes the peer-list
 * assembly that was previously duplicated in /api/agents, /api/orchestrator/
 * refresh and the chat-stream route.
 *
 * Why this matters for delegation: the orchestrator (Jarvis) only "knows"
 * the delegation policy, the sub-agent roster and the tool docs because they
 * live in its MEMORY.md. For Telegram/WhatsApp turns there is no web request
 * to trigger a refresh, so without a boot-time + periodic refresh the policy
 * could go stale (or never be written at all) on a Telegram-only flow.
 */
import { readFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getAllAgentMeta } from "@/lib/agents-meta";
import { refreshAllOrchestrators } from "@/lib/orchestrator-injector";

export async function refreshOrchestratorMemory(): Promise<void> {
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
    role:
      meta[a.id]?.role ??
      (a.id === "main" || a.id === "jarvis" ? "orchestrator" : "specialist"),
    specialty: meta[a.id]?.specialty ?? [],
    briefing_checklist: meta[a.id]?.briefing_checklist ?? [],
  }));
  await refreshAllOrchestrators(peers);
}

let started = false;

/**
 * Boot-time refresh + low-frequency interval (default 10 min). Idempotent:
 * the injector only rewrites MEMORY.md when the rendered block actually
 * changes, so the interval is cheap. Guards against double-start under
 * Next's dual-runtime instrumentation.
 */
export function startOrchestratorMemoryRefresh(intervalMs = 10 * 60 * 1000): void {
  if (started) return;
  started = true;

  const run = () => {
    refreshOrchestratorMemory().catch((err) => {
      console.warn("[orchestrator-refresh] refresh failed:", err);
    });
  };

  // Initial refresh shortly after boot (let the config/sweep settle first).
  setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  // Don't keep the event loop alive just for this.
  if (typeof timer.unref === "function") timer.unref();
}
