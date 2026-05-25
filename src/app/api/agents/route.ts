import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";

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
  const configEmoji = agentConfig?.ui?.emoji;
  const configColor = agentConfig?.ui?.color;
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
      ui: {
        emoji: body.emoji || "🤖",
        color: body.color || "#666666"
      },
      model: newAgentModel,
      workspace: body.workspace || `./workspace/${body.id}`,
      subagents: {
        allowAgents: body.allowAgents || []
      }
    };

    config.agents.list.push(newAgent);

    // Write Telegram config if provided
    if (body.botToken || body.dmPolicy) {
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};
      
      config.channels.telegram.accounts[body.id] = {
        botToken: body.botToken || "",
        dmPolicy: body.dmPolicy || "pairing"
      };
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
    if (!agent.ui) agent.ui = {};
    if (body.emoji) agent.ui.emoji = body.emoji;
    if (body.color) agent.ui.color = body.color;
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
    if (body.workspace) agent.workspace = body.workspace;
    if (!agent.subagents) agent.subagents = { allowAgents: [] };
    if (body.allowAgents) agent.subagents.allowAgents = body.allowAgents;

    // Update Telegram info
    if (body.botToken !== undefined || body.dmPolicy) {
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};
      
      config.channels.telegram.accounts[body.id] = {
        botToken: body.botToken === "configured" ? (config.channels.telegram.accounts[body.id]?.botToken || "") : (body.botToken || ""),
        dmPolicy: body.dmPolicy || "pairing"
      };
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
