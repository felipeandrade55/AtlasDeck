/**
 * Global multi-agent orchestration settings. The dial that matters for
 * non-technical users is `autonomous_mode`: when ON, Jarvis bypasses the
 * approval prompts (plan-decompose, final delivery) and just gets it done.
 *
 * Per-agent overrides live in agents-meta.ts under `override_autonomous`
 * (`inherit` | `force_manual` | `force_auto`). The resolver here returns
 * the effective value after combining the agent override with the global.
 */
import fs from "fs";
import path from "path";

const PATH = path.join(process.cwd(), "data", "orchestration-settings.json");

export type OrchestrationOverride = "inherit" | "force_manual" | "force_auto";

export interface OrchestrationSettings {
  autonomous_mode: boolean;
  require_user_approval: boolean; // when true, "review" never auto-advances to "done"
  cost_caps_enforce: boolean; // when false, caps are advisory only
  notify_on_delegation: boolean; // ping the user when Jarvis delegates
  default_reviewer_id: string | null; // optional Reviewer-role agent for double-check pass
  updated_at: string;
}

const DEFAULTS: OrchestrationSettings = {
  autonomous_mode: false,
  require_user_approval: true,
  cost_caps_enforce: true,
  notify_on_delegation: true,
  default_reviewer_id: null,
  updated_at: new Date(0).toISOString(),
};

function read(): OrchestrationSettings {
  try {
    const raw = fs.readFileSync(PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestrationSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(next: OrchestrationSettings): OrchestrationSettings {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  fs.writeFileSync(PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function getOrchestrationSettings(): OrchestrationSettings {
  return read();
}

export function updateOrchestrationSettings(
  patch: Partial<Omit<OrchestrationSettings, "updated_at">>,
): OrchestrationSettings {
  const current = read();
  const merged: OrchestrationSettings = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  return write(merged);
}

/**
 * Resolves the *effective* autonomous mode for a specific agent, combining
 * the global flag with the per-agent override. Use this everywhere we need
 * to decide "skip approval or not" — never read the raw boolean.
 *
 *   global=ON  + agent=inherit       → autonomous
 *   global=ON  + agent=force_manual  → manual (agent opt-out)
 *   global=OFF + agent=force_auto    → autonomous (agent opt-in)
 *   global=OFF + agent=inherit       → manual
 */
export function isAutonomousFor(override: OrchestrationOverride | undefined | null): boolean {
  if (override === "force_auto") return true;
  if (override === "force_manual") return false;
  return read().autonomous_mode;
}
