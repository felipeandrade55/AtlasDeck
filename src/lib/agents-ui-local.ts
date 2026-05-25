/**
 * Local storage for agent UI fields (emoji + color) that OpenClaw doesn't
 * accept inside its own `openclaw.json`.
 *
 * Older AtlasDeck code wrote `agents.list[].ui = { emoji, color }` directly
 * into the OpenClaw config. OpenClaw 2026.5.12+ validates strictly and
 * rejects the whole config with "Unrecognized key: ui", preventing the
 * daemon from starting at all.
 *
 * The fix: keep emoji/color in this AtlasDeck-local JSON file, keyed by
 * agent id. OpenClaw never sees these fields. The /api/agents handler
 * merges them in for display and persists them here on create/update.
 */
import fs from "fs";
import path from "path";

const UI_PATH = path.join(process.cwd(), "data", "agents-ui.json");

export interface AgentUiEntry {
  emoji?: string;
  color?: string;
}

function readAll(): Record<string, AgentUiEntry> {
  try {
    const raw = fs.readFileSync(UI_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AgentUiEntry>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, AgentUiEntry>) {
  fs.mkdirSync(path.dirname(UI_PATH), { recursive: true });
  fs.writeFileSync(UI_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getAgentUi(id: string): AgentUiEntry {
  return readAll()[id] || {};
}

export function setAgentUi(id: string, ui: AgentUiEntry): void {
  if (!id) return;
  const all = readAll();
  const existing = all[id] || {};
  const next: AgentUiEntry = { ...existing };
  if (typeof ui.emoji === "string" && ui.emoji.trim()) next.emoji = ui.emoji.trim();
  if (typeof ui.color === "string" && ui.color.trim()) next.color = ui.color.trim();
  // Only persist if something is actually set
  if (next.emoji || next.color) {
    all[id] = next;
    writeAll(all);
  }
}

export function deleteAgentUi(id: string): void {
  if (!id) return;
  const all = readAll();
  if (id in all) {
    delete all[id];
    writeAll(all);
  }
}

/**
 * Strip `ui` from any agent in the openclaw.json structure (in-place) and
 * move the values to local storage. Returns true if the openclaw.json
 * needs to be rewritten because something was migrated.
 *
 * Idempotent — safe to call on every read.
 */
export function migrateAgentUiFromConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const root = config as { agents?: { list?: Array<Record<string, unknown>> } };
  const list = root.agents?.list;
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (const agent of list) {
    if (typeof agent !== "object" || agent === null) continue;
    if (typeof agent.id !== "string") continue;
    if (agent.ui && typeof agent.ui === "object") {
      const ui = agent.ui as { emoji?: unknown; color?: unknown };
      setAgentUi(agent.id, {
        emoji: typeof ui.emoji === "string" ? ui.emoji : undefined,
        color: typeof ui.color === "string" ? ui.color : undefined,
      });
      delete agent.ui;
      changed = true;
    }
  }
  return changed;
}
