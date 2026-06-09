import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path, { isAbsolute, resolve } from "path";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { OPENCLAW_DIR } from "@/lib/paths";
import { logActivity } from "@/lib/activities-db";
import { setAgentUi } from "@/lib/agents-ui-local";
import { setAgentMeta, getAllAgentMeta } from "@/lib/agents-meta";
import { refreshAllOrchestrators, injectAgentSystemPrompt } from "@/lib/orchestrator-injector";
import { normalizeWorkspacePath } from "@/lib/workspace-migration";

export const dynamic = "force-dynamic";

/**
 * "Modo Supremo" — bulk-activate the whole specialist squad in one shot.
 *
 * Reads the agent templates and, for each one, CREATES it (if missing) or
 * UPDATES it (if it already exists) to the canonical "supreme" version:
 * pt-BR name, rich system_prompt, briefing_checklist, role/specialty and
 * cost caps. Every non-orchestrator agent is then auto-linked into every
 * orchestrator's `allowAgents` so Jarvis can delegate to all of them
 * immediately. The custom system_prompt is written into each agent's
 * workspace MEMORY.md.
 *
 * On EXISTING agents we intentionally DON'T touch model/workspace/Telegram
 * — those may have been tuned by the user. We only sync the "supreme"
 * content (name, emoji/color, role, specialty, prompt, checklist, caps).
 *
 * Single config write, then refreshAllOrchestrators so the orchestrator's
 * MEMORY.md reflects the new roster + each agent's briefing checklist.
 */

const TEMPLATES_OVERRIDE = path.join(process.cwd(), "data", "agent-templates.json");
const TEMPLATES_EXAMPLE = path.join(process.cwd(), "data", "agent-templates.example.json");

function resolveTemplatesPath(): string {
  return existsSync(TEMPLATES_OVERRIDE) ? TEMPLATES_OVERRIDE : TEMPLATES_EXAMPLE;
}

interface Template {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  role?: "orchestrator" | "specialist" | "reviewer";
  specialty?: string[];
  inherit_jarvis_skills?: boolean;
  suggested_model?: string;
  suggested_fallback?: string;
  system_prompt?: string;
  briefing_checklist?: string[];
  default_cost_caps?: { per_task_cents?: number; per_day_cents?: number };
}

/** Mirror of route.ts normalizeModelId — prefix bare ids so OpenClaw's strict schema accepts them. */
function normalizeModelId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9_-]+\//i.test(trimmed)) return trimmed;
  return `openai/${trimmed}`;
}

function ensureWorkspaceDir(workspace: string) {
  const abs = isAbsolute(workspace) ? workspace : resolve(OPENCLAW_DIR, workspace);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
}

export async function POST() {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const raw = readFileSync(resolveTemplatesPath(), "utf-8");
    const parsed = JSON.parse(raw) as { templates?: Template[] };
    const templates = Array.isArray(parsed.templates) ? parsed.templates : [];
    if (!templates.length) {
      return NextResponse.json({ error: "Nenhum template encontrado." }, { status: 400 });
    }

    // Known-good model for new agents: clone whatever the orchestrator (Jarvis)
    // uses — it's already accepted by this OpenClaw install. NEVER trust the
    // template-hardcoded model ids: they may name models this install hasn't
    // authenticated (e.g. "openai/gpt-5.4" / uninstalled ollama fallbacks),
    // which makes OpenClaw reject the WHOLE config and crash-loop the gateway.
    // Fallback chain: orchestrator model → global defaults → template suggestion.
    const orchestratorAgent = config.agents.list.find(
      (a: any) => a.id === "main" || a.id === "jarvis",
    );
    const inheritedModel =
      (orchestratorAgent && orchestratorAgent.model) ||
      config.agents?.defaults?.model ||
      null;

    const created: string[] = [];
    const updated: string[] = [];
    // Collect agents whose MEMORY.md we must (re)write with the prompt.
    const promptTargets: Array<{ id: string; workspace: string; system_prompt?: string }> = [];

    for (const t of templates) {
      if (!t.id || !t.name) continue;
      const role = t.role || "specialist";
      const existing = config.agents.list.find((a: any) => a.id === t.id);

      if (existing) {
        // Sync supreme content. Also RE-ALIGN the model to the orchestrator's
        // (inheritedModel): this makes a Modo Supremo run double as a repair —
        // agents left with an invalid model by an earlier version get fixed
        // in one click (no SSH needed). Workspace/Telegram stay as-is; the
        // user can re-pick a model manually afterward.
        existing.name = t.name;
        if (inheritedModel) {
          existing.model = JSON.parse(JSON.stringify(inheritedModel));
        }
        updated.push(t.id);
        promptTargets.push({ id: t.id, workspace: existing.workspace, system_prompt: t.system_prompt });
      } else {
        // Inherit the orchestrator's model (see inheritedModel above). Only
        // fall back to the template suggestion when there's no orchestrator/
        // default model to copy (fresh install with no agents yet).
        let model: any;
        if (inheritedModel) {
          model = JSON.parse(JSON.stringify(inheritedModel));
        } else {
          model = { primary: normalizeModelId(t.suggested_model) || "openai/gpt-5.5" };
          const fb = normalizeModelId(t.suggested_fallback);
          if (fb) model.fallback = fb;
        }
        const workspace = normalizeWorkspacePath(`./workspace/${t.id}`);
        const newAgent = {
          id: t.id,
          name: t.name,
          model,
          workspace,
          subagents: { allowAgents: [] as string[] },
        };
        try {
          ensureWorkspaceDir(workspace);
        } catch (e) {
          console.error(`[activate-all] mkdir workspace failed for ${t.id}:`, e);
        }
        config.agents.list.push(newAgent);
        created.push(t.id);
        promptTargets.push({ id: t.id, workspace, system_prompt: t.system_prompt });
      }

      // UI + orchestration meta (local storage, outside openclaw.json).
      setAgentUi(t.id, { emoji: t.emoji || "🤖", color: t.color || "#666666" });
      setAgentMeta(t.id, {
        role,
        specialty: Array.isArray(t.specialty) ? t.specialty : [],
        inherit_jarvis_skills:
          typeof t.inherit_jarvis_skills === "boolean" ? t.inherit_jarvis_skills : true,
        cost_caps: t.default_cost_caps ?? {},
        template_id: t.id,
        system_prompt: typeof t.system_prompt === "string" ? t.system_prompt : undefined,
        briefing_checklist: Array.isArray(t.briefing_checklist) ? t.briefing_checklist : [],
      });
    }

    // Auto-link: every non-orchestrator agent becomes delegable from every
    // orchestrator. Recompute roles from meta (now that templates are saved).
    const meta = getAllAgentMeta();
    const roleOf = (id: string): string =>
      meta[id]?.role ?? (id === "main" || id === "jarvis" ? "orchestrator" : "specialist");
    const orchestrators = config.agents.list.filter((a: any) => roleOf(a.id) === "orchestrator");
    const delegables = config.agents.list
      .filter((a: any) => roleOf(a.id) !== "orchestrator")
      .map((a: any) => a.id);
    for (const orch of orchestrators) {
      if (!orch.subagents) orch.subagents = { allowAgents: [] };
      if (!Array.isArray(orch.subagents.allowAgents)) orch.subagents.allowAgents = [];
      for (const id of delegables) {
        if (id !== orch.id && !orch.subagents.allowAgents.includes(id)) {
          orch.subagents.allowAgents.push(id);
        }
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Write each agent's system_prompt into its workspace MEMORY.md.
    for (const tgt of promptTargets) {
      if (tgt.system_prompt && tgt.system_prompt.trim()) {
        await injectAgentSystemPrompt({ id: tgt.id, workspace: tgt.workspace }, tgt.system_prompt);
      }
    }

    // Refresh orchestrators' MEMORY.md (roster + briefing checklists + consultive section).
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
      console.warn("[activate-all] refreshAllOrchestrators failed:", e);
    }

    try {
      logActivity(
        "agent",
        `Modo Supremo: ${created.length} criados, ${updated.length} atualizados, conectados ao Jarvis`,
        "success",
        { metadata: { created, updated } },
      );
    } catch {}

    return NextResponse.json({
      success: true,
      created,
      updated,
      total: created.length + updated.length,
      linked_to: orchestrators.map((o: any) => o.id),
    });
  } catch (error: any) {
    console.error("[activate-all] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * "Desativar Modo Supremo" — disconnect the whole squad from the
 * orchestrator(s) WITHOUT deleting any agent. Clears every orchestrator's
 * `allowAgents`, so Jarvis stops delegating and operates solo again. Fully
 * reversible: a POST re-links everything. Agents, prompts and meta are
 * preserved untouched.
 */
export async function DELETE() {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const meta = getAllAgentMeta();
    const roleOf = (id: string): string =>
      meta[id]?.role ?? (id === "main" || id === "jarvis" ? "orchestrator" : "specialist");

    let unlinked = 0;
    for (const a of config.agents.list) {
      if (roleOf(a.id) === "orchestrator" && Array.isArray(a.subagents?.allowAgents) && a.subagents.allowAgents.length) {
        unlinked += a.subagents.allowAgents.length;
        a.subagents.allowAgents = [];
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
      console.warn("[activate-all] DELETE refreshAllOrchestrators failed:", e);
    }

    try {
      logActivity("agent", "Modo Supremo desativado: squad desconectado do Jarvis", "success", {
        metadata: { unlinked },
      });
    } catch {}

    return NextResponse.json({ success: true, unlinked });
  } catch (error: any) {
    console.error("[activate-all] DELETE error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
