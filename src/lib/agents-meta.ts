/**
 * Local storage for agent metadata fields that OpenClaw doesn't accept in
 * its strict-schema openclaw.json: role, specialty, inherit_jarvis_skills,
 * override_autonomous, cost_caps.
 *
 * Same pattern as agents-ui-local.ts: kept in AtlasDeck's data/ dir, merged
 * in by the /api/agents handler at read time. OpenClaw never sees these.
 */
import fs from "fs";
import path from "path";

const META_PATH = path.join(process.cwd(), "data", "agents-meta.json");

export type AgentRole = "orchestrator" | "specialist" | "reviewer";
export type AgentAutonomousOverride = "inherit" | "force_manual" | "force_auto";

export interface AgentCostCaps {
  per_task_cents?: number | null;
  per_day_cents?: number | null;
}

export interface AgentMetaEntry {
  role?: AgentRole;
  specialty?: string[];
  inherit_jarvis_skills?: boolean;
  override_autonomous?: AgentAutonomousOverride;
  cost_caps?: AgentCostCaps;
  template_id?: string;
}

function readAll(): Record<string, AgentMetaEntry> {
  try {
    const raw = fs.readFileSync(META_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AgentMetaEntry>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, AgentMetaEntry>) {
  fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Default role inference for agents that haven't been migrated yet.
 * Main / Jarvis = orchestrator, everything else = specialist.
 */
export function defaultRoleFor(agentId: string): AgentRole {
  if (agentId === "main" || agentId === "jarvis") return "orchestrator";
  return "specialist";
}

export function getAgentMeta(id: string): AgentMetaEntry {
  const entry = readAll()[id] || {};
  // Provide defaults for missing fields so callers never have to null-check.
  return {
    role: entry.role ?? defaultRoleFor(id),
    specialty: entry.specialty ?? [],
    inherit_jarvis_skills: entry.inherit_jarvis_skills ?? true,
    override_autonomous: entry.override_autonomous ?? "inherit",
    cost_caps: entry.cost_caps ?? {},
    template_id: entry.template_id,
  };
}

export function getAllAgentMeta(): Record<string, AgentMetaEntry> {
  return readAll();
}

export function setAgentMeta(id: string, meta: Partial<AgentMetaEntry>): void {
  if (!id) return;
  const all = readAll();
  const existing = all[id] || {};
  const next: AgentMetaEntry = { ...existing };
  if (meta.role !== undefined) next.role = meta.role;
  if (meta.specialty !== undefined) {
    next.specialty = Array.isArray(meta.specialty)
      ? meta.specialty.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : [];
  }
  if (meta.inherit_jarvis_skills !== undefined) next.inherit_jarvis_skills = !!meta.inherit_jarvis_skills;
  if (meta.override_autonomous !== undefined) next.override_autonomous = meta.override_autonomous;
  if (meta.cost_caps !== undefined) {
    const caps: AgentCostCaps = {};
    if (typeof meta.cost_caps.per_task_cents === "number" && meta.cost_caps.per_task_cents >= 0) {
      caps.per_task_cents = meta.cost_caps.per_task_cents;
    }
    if (typeof meta.cost_caps.per_day_cents === "number" && meta.cost_caps.per_day_cents >= 0) {
      caps.per_day_cents = meta.cost_caps.per_day_cents;
    }
    next.cost_caps = caps;
  }
  if (meta.template_id !== undefined) next.template_id = meta.template_id || undefined;

  all[id] = next;
  writeAll(all);
}

export function deleteAgentMeta(id: string): void {
  if (!id) return;
  const all = readAll();
  if (id in all) {
    delete all[id];
    writeAll(all);
  }
}
