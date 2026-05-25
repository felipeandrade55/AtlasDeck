import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";
import { OPENCLAW_DIR } from "@/lib/paths";
import {
  getAgentUi,
  setAgentUi,
  deleteAgentUi,
  migrateAgentUiFromConfig,
} from "@/lib/agents-ui-local";
import { normalizeWorkspacePath } from "@/lib/workspace-migration";

/**
 * The agent.workspace field is stored relative to OpenClaw's home dir
 * (typically `~/.openclaw`). We mkdir it on save so the daemon doesn't
 * fail with "workspace not found" the first time the agent receives a
 * message — that was the silent root cause of the "Something went wrong"
 * Telegram bot reply: the workspace folder never existed.
 */
function ensureAgentWorkspace(workspace: string): { absolutePath: string; created: boolean } {
  const abs = isAbsolute(workspace) ? workspace : resolve(OPENCLAW_DIR, workspace);
  const existed = existsSync(abs);
  if (!existed) {
    mkdirSync(abs, { recursive: true });
  }
  return { absolutePath: abs, created: !existed };
}

/**
 * BUG RECOVERY: previously this function ADDED `agents.bindings[]` entries
 * thinking that was the correct schema for telegram→agent routing. It is
 * NOT — OpenClaw 2026.5.12 strict-schema rejects `agents.bindings`:
 *
 *   Invalid config: agents: Unrecognized key: "bindings"
 *
 * Worse, this ran on every GET /api/agents (polled every 8s by the dashboard),
 * so AtlasDeck was constantly re-corrupting the config seconds after the user
 * ran `openclaw doctor --fix`. Daemon then refused to boot.
 *
 * Now: REMOVE any stale `agents.bindings` we find (defensive cleanup of our
 * own past mess). Don't try to "set up" routing — let `openclaw doctor --fix`
 * or `openclaw configure` handle that (they know the canonical schema).
 *
 * If your bot isn't routing messages and you have one Telegram account named
 * "main" + one agent named "main", rename the account to "default" via the
 * Telegram setup modal OR run `openclaw doctor --fix` on the server.
 */
function ensureTelegramBindings(config: any): boolean {
  if (config?.agents?.bindings !== undefined) {
    delete config.agents.bindings;
    return true;
  }
  return false;
}

export const dynamic = "force-dynamic";

interface Agent {
  id: string;
  name?: string;
  emoji: string;
  color: string;
  model: string;
  fallback?: string;
  workspace: string;
  dmPolicy?: string;
  allowAgents?: string[];
  allowAgentsDetails?: Array<{
    id: string;
    name: string;
    emoji: string;
    color: string;
  }>;
  botToken?: string;
  status: "online" | "offline";
  lastActivity?: string;
  activeSessions: number;
}

/**
 * OpenClaw's `model` field has historically used different shapes:
 *  - { primary: "openai/...", fallback: "ollama/..." }
 *  - { primary: "openai/...", fallbacks: ["ollama/..."] }
 * We read either shape and surface a single "fallback" string upward.
 */
function readFallback(modelObj: unknown): string | undefined {
  if (!modelObj || typeof modelObj !== "object") return undefined;
  const obj = modelObj as { fallback?: unknown; fallbacks?: unknown };
  if (typeof obj.fallback === "string" && obj.fallback.trim()) return obj.fallback.trim();
  if (Array.isArray(obj.fallbacks)) {
    const first = obj.fallbacks.find((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (first) return first.trim();
  }
  return undefined;
}

const DEFAULT_AGENT_CONFIG: Record<string, { emoji: string; color: string; name?: string }> = {
  main: {
    emoji: process.env.NEXT_PUBLIC_AGENT_EMOJI || "🤖",
    color: "#ff6b35",
    name: process.env.NEXT_PUBLIC_AGENT_NAME || "Mission Control",
  },
};

function getAgentDisplayInfo(agentId: string, agentConfig: any): { emoji: string; color: string; name: string } {
  // Read from AtlasDeck-local storage first (where emoji/color now live so
  // they don't pollute openclaw.json's strict schema). Fall back to the
  // legacy `ui` field on the agent (for configs not yet migrated), then to
  // hardcoded defaults.
  const localUi = getAgentUi(agentId);
  const configEmoji = localUi.emoji || agentConfig?.ui?.emoji;
  const configColor = localUi.color || agentConfig?.ui?.color;
  const configName = agentConfig?.name;
  const defaults = DEFAULT_AGENT_CONFIG[agentId];

  return {
    emoji: configEmoji || defaults?.emoji || "🤖",
    color: configColor || defaults?.color || "#666666",
    name: configName || defaults?.name || agentId,
  };
}

export async function GET() {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    // One-shot migration: if any agent in the file has a `ui` key, move it
    // to AtlasDeck-local storage and remove from openclaw.json. Older code
    // wrote `ui` into the agent object, but OpenClaw 2026.5.12+ rejects it
    // ("Unrecognized key: ui"), which prevents the daemon from starting.
    const uiMigrated = migrateAgentUiFromConfig(config);
    // Defensive cleanup: remove any stale agents.bindings AtlasDeck wrote
    // in a previous (bad) migration. OpenClaw 2026.5.12 rejects that key
    // and refuses to boot.
    const bindingsStripped = ensureTelegramBindings(config);
    if (uiMigrated || bindingsStripped) {
      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        const what = [
          uiMigrated && "ui→local",
          bindingsStripped && "stripped invalid agents.bindings",
        ]
          .filter(Boolean)
          .join(" + ");
        logActivity("config", `Migração openclaw.json: ${what}`, "success", { metadata: { configPath } });
      } catch (e) {
        console.error("Failed to persist openclaw.json migrations:", e);
      }
    }

    if (!config.agents?.list?.length) {
      return NextResponse.json({ agents: [], isDemo: true });
    }

    const agents: Agent[] = config.agents.list.map((agent: any) => {
      const agentInfo = getAgentDisplayInfo(agent.id, agent);
      const telegramAccount = config.channels?.telegram?.accounts?.[agent.id];
      const botToken = telegramAccount?.botToken;

      const memoryPath = join(agent.workspace, "memory");
      let lastActivity = undefined;
      let status: "online" | "offline" = "offline";

      try {
        const today = new Date().toISOString().split("T")[0];
        const memoryFile = join(memoryPath, `${today}.md`);
        const stat = statSync(memoryFile);
        lastActivity = stat.mtime.toISOString();
        status = Date.now() - stat.mtime.getTime() < 5 * 60 * 1000 ? "online" : "offline";
      } catch (e) {}

      const allowAgents = agent.subagents?.allowAgents || [];
      const allowAgentsDetails = allowAgents.map((subagentId: string) => {
        const subagentConfig = config.agents.list.find((a: any) => a.id === subagentId);
        if (subagentConfig) {
          const subagentInfo = getAgentDisplayInfo(subagentId, subagentConfig);
          return {
            id: subagentId,
            name: subagentConfig.name || subagentInfo.name,
            emoji: subagentInfo.emoji,
            color: subagentInfo.color,
          };
        }
        const fallbackInfo = getAgentDisplayInfo(subagentId, null);
        return {
          id: subagentId,
          name: fallbackInfo.name,
          emoji: fallbackInfo.emoji,
          color: fallbackInfo.color,
        };
      });

      return {
        id: agent.id,
        name: agent.name || agentInfo.name,
        emoji: agentInfo.emoji,
        color: agentInfo.color,
        model: agent.model?.primary || config.agents.defaults?.model?.primary || "openai/gpt-5.4-codex",
        fallback: readFallback(agent.model) ?? readFallback(config.agents.defaults?.model),
        workspace: agent.workspace,
        dmPolicy: telegramAccount?.dmPolicy || config.channels?.telegram?.dmPolicy || "pairing",
        allowAgents,
        allowAgentsDetails,
        botToken: botToken ? "configured" : undefined,
        status,
        lastActivity,
        activeSessions: 0,
      };
    });

    return NextResponse.json({ agents });
  } catch (error: any) {
    console.error("Error reading agents:", error);
    return NextResponse.json({ agents: [], error: error.message });
  }
}

export async function POST(request: Request) {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const body = await request.json();

    if (!body.id || !body.name) {
      return NextResponse.json({ error: "Missing id or name" }, { status: 400 });
    }

    // Ensure agents.list exists — older / hand-edited openclaw.json may have
    // `agents.defaults` set but `list` missing, which would crash .some()/.push()
    // with "Cannot read properties of undefined (reading 'some')".
    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    // Check duplicate
    if (config.agents.list.some((a: any) => a.id === body.id)) {
      return NextResponse.json({ error: "Agent ID already exists" }, { status: 400 });
    }

    const newAgentModel: { primary: string; fallback?: string } = {
      primary: body.model || config.agents.defaults?.model?.primary || "openai/gpt-5.4-codex",
    };
    if (typeof body.fallback === "string" && body.fallback.trim()) {
      newAgentModel.fallback = body.fallback.trim();
    }

    const newAgent = {
      id: body.id,
      name: body.name,
      model: newAgentModel,
      // Normalize workspace path so we don't write malformed values like
      // `.openclaw/workspace/main` (without ./) that would later resolve
      // to /root/.openclaw/.openclaw/workspace/main and break imports.
      workspace: normalizeWorkspacePath(body.workspace || `./workspace/${body.id}`),
      subagents: {
        allowAgents: body.allowAgents || []
      }
    };

    // Make sure the workspace directory exists — OpenClaw fails silently
    // ("Something went wrong, use /new") when an agent tries to use a
    // workspace path that's missing from disk.
    try {
      ensureAgentWorkspace(newAgent.workspace);
    } catch (e) {
      console.error("Failed to create agent workspace:", e);
    }

    // Defensive: strip any invalid agents.bindings (legacy from past bad migration)
    ensureTelegramBindings(config);

    // emoji/color go to AtlasDeck-local storage, NEVER into openclaw.json
    // (OpenClaw rejects unknown keys in agents.list entries)
    setAgentUi(body.id, {
      emoji: body.emoji || "🤖",
      color: body.color || "#666666",
    });

    config.agents.list.push(newAgent);

    // Telegram config: merge, NEVER replace. Older code rewrote the entire
    // accounts[id] object even when the user didn't touch the Telegram fields,
    // wiping a previously-saved botToken/chatId. We now only touch a field if
    // the caller explicitly provided a non-empty value for it. Editing tokens
    // is the TelegramSetupModal's job.
    const hasIncomingToken =
      typeof body.botToken === "string" && body.botToken.trim() && body.botToken !== "configured";
    const hasIncomingDmPolicy = typeof body.dmPolicy === "string" && body.dmPolicy.trim();
    if (hasIncomingToken || hasIncomingDmPolicy) {
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};

      const existingAccount = config.channels.telegram.accounts[body.id] || {};
      const nextAccount = { ...existingAccount };
      if (hasIncomingToken) nextAccount.botToken = body.botToken.trim();
      if (hasIncomingDmPolicy) nextAccount.dmPolicy = body.dmPolicy;
      config.channels.telegram.accounts[body.id] = nextAccount;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    try {
      logActivity("agent", `Agente criado: ${newAgent.name} (${newAgent.id})`, "success", {
        agent: newAgent.id,
        metadata: { id: newAgent.id, model: newAgent.model?.primary, workspace: newAgent.workspace },
      });
    } catch {}
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const body = await request.json();

    if (!body.id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const index = config.agents.list.findIndex((a: any) => a.id === body.id);
    if (index === -1) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Update Agent fields
    const agent = config.agents.list[index];
    if (body.name) agent.name = body.name;
    // emoji/color persisted in AtlasDeck-local storage (out of openclaw.json)
    if (body.emoji || body.color) {
      setAgentUi(body.id, { emoji: body.emoji, color: body.color });
    }
    // Defensive: if a legacy `ui` key crept in from old code or hand edits,
    // strip it so OpenClaw doesn't reject the config on next reload.
    if ("ui" in agent) delete agent.ui;
    if (!agent.model) agent.model = {};
    if (body.model) agent.model.primary = body.model;
    // fallback handling: preserve original shape (`fallback` string or `fallbacks` array)
    if (body.fallback !== undefined) {
      const fb = typeof body.fallback === "string" ? body.fallback.trim() : "";
      if (Array.isArray(agent.model.fallbacks)) {
        agent.model.fallbacks = fb ? [fb] : [];
      } else if (fb) {
        agent.model.fallback = fb;
      } else {
        delete agent.model.fallback;
      }
    }
    if (body.workspace) agent.workspace = normalizeWorkspacePath(body.workspace);
    // Defensive: normalize any pre-existing malformed workspace value too
    if (typeof agent.workspace === "string") {
      const normalized = normalizeWorkspacePath(agent.workspace);
      if (normalized !== agent.workspace) agent.workspace = normalized;
    }
    if (!agent.subagents) agent.subagents = { allowAgents: [] };
    if (body.allowAgents) agent.subagents.allowAgents = body.allowAgents;

    // Ensure workspace exists on disk (covers both initial create + later edits
    // that change the path or that pre-date this safeguard)
    if (agent.workspace) {
      try {
        ensureAgentWorkspace(agent.workspace);
      } catch (e) {
        console.error("Failed to create agent workspace:", e);
      }
    }

    // Defensive: strip any invalid agents.bindings (legacy from past bad migration)
    ensureTelegramBindings(config);

    // Telegram config: merge, never replace. See POST handler for context —
    // the old code wiped chatId and overwrote botToken with "" whenever the
    // agent modal saved without filling those fields.
    const putHasIncomingToken =
      typeof body.botToken === "string" && body.botToken.trim() && body.botToken !== "configured";
    const putHasIncomingDmPolicy = typeof body.dmPolicy === "string" && body.dmPolicy.trim();
    if (putHasIncomingToken || putHasIncomingDmPolicy) {
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};

      const existingAccount = config.channels.telegram.accounts[body.id] || {};
      const nextAccount = { ...existingAccount };
      if (putHasIncomingToken) nextAccount.botToken = body.botToken.trim();
      if (putHasIncomingDmPolicy) nextAccount.dmPolicy = body.dmPolicy;
      config.channels.telegram.accounts[body.id] = nextAccount;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    try {
      const changed = Object.keys(body).filter((k) => k !== "id");
      logActivity("agent", `Agente atualizado: ${agent.name} (${body.id})`, "success", {
        agent: body.id,
        metadata: { id: body.id, fields: changed },
      });
    } catch {}
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
    }

    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const existingAgent = config.agents.list.find((a: any) => a.id === id);
    config.agents.list = config.agents.list.filter((a: any) => a.id !== id);

    // Clean AtlasDeck-local UI storage too (emoji/color)
    deleteAgentUi(id);

    // Clean telegram config
    if (config.channels?.telegram?.accounts?.[id]) {
      delete config.channels.telegram.accounts[id];
    }

    // Clean delegation dependencies from other agents
    config.agents.list.forEach((agent: any) => {
      if (agent.subagents?.allowAgents) {
        agent.subagents.allowAgents = agent.subagents.allowAgents.filter((subId: string) => subId !== id);
      }
    });

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    try {
      logActivity("agent", `Agente removido: ${existingAgent?.name ?? id}`, "success", {
        agent: id,
        metadata: { id },
      });
    } catch {}
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
