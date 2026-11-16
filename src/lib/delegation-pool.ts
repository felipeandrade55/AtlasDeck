/**
 * Single source of truth for "who may this orchestrator delegate to?".
 *
 * The UI controls delegation through `subagents.allowAgents` on the
 * orchestrator's OpenClaw agent entry:
 *   - "Ativar Modo Supremo"     → fills allowAgents with every specialist
 *   - "Desativar Modo Supremo"  → empties allowAgents (solo mode)
 *   - squad-link toggle         → adds/removes one id
 *
 * Every AtlasDeck delegation path (MEMORY.md policy, chat-stream hint,
 * delegate_to / decompose, list_squad, auto-link on agent creation) must go
 * through this helper so the toggle actually means something. An empty or
 * missing allowAgents = SOLO: the orchestrator executes the work itself.
 * `"*"` in allowAgents = any agent (OpenClaw's own wildcard semantics).
 */
import { existsSync, readFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getAgentList } from "@/lib/openclaw-agents-compat";

export interface DelegationPool {
  /** True when the orchestrator must not delegate (empty/missing allowAgents). */
  solo: boolean;
  /** True when allowAgents contains the "*" wildcard. */
  allowAll: boolean;
  /** Explicit agent ids allowed (wildcard excluded). */
  allowed: string[];
}

const SOLO: DelegationPool = { solo: true, allowAll: false, allowed: [] };

function readAgentList(): Array<Record<string, unknown>> {
  const { path: configPath } = resolveOpenClawAgentsConfigPath();
  if (!existsSync(configPath)) return [];
  return getAgentList(JSON.parse(readFileSync(configPath, "utf-8")));
}

/** Pool computed from an already-loaded agent list (no I/O). */
export function delegationPoolFromList(
  list: Array<Record<string, unknown>>,
  orchestratorId: string = "main",
): DelegationPool {
  const agent = list.find((a) => a && a.id === orchestratorId);
  const subagents = agent?.subagents as { allowAgents?: unknown } | undefined;
  const raw = Array.isArray(subagents?.allowAgents) ? (subagents!.allowAgents as unknown[]) : [];
  const ids = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const allowAll = ids.includes("*");
  const allowed = ids.filter((id) => id !== "*" && id !== orchestratorId);
  if (!allowAll && allowed.length === 0) return SOLO;
  return { solo: false, allowAll, allowed };
}

/**
 * Reads openclaw.json and returns the orchestrator's delegation pool. Any read
 * or parse failure falls back to SOLO — doing the work inline is always safer
 * than handing it to an agent we can't verify.
 */
export function getDelegationPool(orchestratorId: string = "main"): DelegationPool {
  try {
    return delegationPoolFromList(readAgentList(), orchestratorId);
  } catch {
    return SOLO;
  }
}

export function canDelegateTo(pool: DelegationPool, agentId: string): boolean {
  if (pool.solo) return false;
  return pool.allowAll || pool.allowed.includes(agentId);
}

/** User-facing error returned by delegate_to / decompose when blocked. */
export function delegationBlockedMessage(pool: DelegationPool, agentId: string): string {
  if (pool.solo) {
    return (
      "Modo solo ativo (Modo Supremo desligado): delegação desabilitada. " +
      "Execute a tarefa você mesmo com suas próprias ferramentas e responda o resultado direto ao usuário."
    );
  }
  return (
    `O agente "${agentId}" não está no squad liberado para delegação ` +
    `(permitidos: ${pool.allowed.join(", ") || "nenhum"}). ` +
    "Delegue a um agente permitido ou execute a tarefa você mesmo."
  );
}
