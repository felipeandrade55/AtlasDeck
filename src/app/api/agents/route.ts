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
import {
  getAgentMeta,
  setAgentMeta,
  deleteAgentMeta,
  getAllAgentMeta,
  type AgentRole,
  type AgentAutonomousOverride,
  type AgentCostCaps,
  type AgentMetaEntry,
} from "@/lib/agents-meta";
import { refreshAllOrchestrators } from "@/lib/orchestrator-injector";
import { normalizeWorkspacePath } from "@/lib/workspace-migration";

/**
 * Re-render the managed orchestrator block in every orchestrator's
 * MEMORY.md. Called after any mutation that could change the swarm shape
 * (new agent, role change, deletion). Best-effort: failures are logged but
 * never block the API response.
 */
async function refreshOrchestratorsBestEffort(
  configList: Array<{ id: string; name?: string; workspace?: string }>,
): Promise<void> {
  try {
    const meta = getAllAgentMeta();
    const peers = configList.map((a) => ({
      id: a.id,
      name: a.name,
      workspace: a.workspace,
      role:
        meta[a.id]?.role ??
        (a.id === "main" || a.id === "jarvis" ? "orchestrator" : "specialist"),
      specialty: meta[a.id]?.specialty ?? [],
    }));
    await refreshAllOrchestrators(peers);
  } catch (e) {
    console.warn("[/api/agents] refreshAllOrchestrators failed:", e);
  }
}

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

/**
 * Self-heal: clamp `dmPolicy` to one of OpenClaw's canonical values.
 *
 * OpenClaw's Telegram channel only understands `pairing`, `open`, and
 * `off`. Anything else (e.g. `allowlist` left from an old UI option or
 * hand-edit) makes the daemon silently drop incoming DMs — symptom: bot
 * is "Conectado", chat is paired, but messages never trigger a response
 * and the agent shows "Última ação: Nunca".
 *
 * Normalizes both the channel-level default and each account's override.
 * Returns ids of any account that was clamped (for the migration log).
 */
const VALID_DM_POLICIES = new Set(["pairing", "open", "off"]);
function normalizeTelegramDmPolicies(config: any): string[] {
  const tg = config?.channels?.telegram;
  if (!tg) return [];
  const fixed: string[] = [];

  if (typeof tg.dmPolicy === "string" && !VALID_DM_POLICIES.has(tg.dmPolicy)) {
    tg.dmPolicy = "pairing";
    fixed.push("(channel default)");
  }
  const accounts = tg.accounts;
  if (accounts && typeof accounts === "object") {
    for (const id of Object.keys(accounts)) {
      const acct = accounts[id];
      if (acct && typeof acct.dmPolicy === "string" && !VALID_DM_POLICIES.has(acct.dmPolicy)) {
        acct.dmPolicy = "pairing";
        fixed.push(id);
      }
    }
  }
  return fixed;
}

/**
 * Self-heal: drop "phantom" sub-agent Telegram accounts.
 *
 * Background: the previous shareBotWith implementation copied the parent's
 * botToken into `channels.telegram.accounts[<sub_id>]` so sub-agents could
 * "ride on" the main bot. That created multiple accounts on the same bot
 * — OpenClaw then tried to pair each as a separate destination, leaving
 * every sub-agent stuck in "1 pendente" forever and breaking the parent's
 * routing along the way. Symptom: bot stops responding the moment a second
 * agent is created.
 *
 * Correct architecture: only the orchestrator (main) owns the Telegram
 * account. Sub-agents are invoked by main via `delegate_to` and never
 * appear as Telegram destinations. The bot-sharing relationship lives in
 * `agents-meta.json` under `shares_bot_with`, not in openclaw.json.
 *
 * This function strips a sub-account when ALL of:
 *   - id !== "main"
 *   - its botToken matches main's
 *   - it has no `chatId` of its own (so we're not deleting a real binding)
 *   - OR the AtlasDeck meta marks it as `shares_bot_with` something
 *
 * The result is OpenClaw seeing exactly one account per real bot, which
 * unbreaks routing. Idempotent — safe on every GET.
 */
function stripSubAgentTelegramAccounts(
  config: any,
  metaMap: Record<string, AgentMetaEntry>,
): string[] {
  const accounts = config?.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const mainAccount = accounts.main;
  const mainToken =
    typeof mainAccount?.botToken === "string" ? mainAccount.botToken.trim() : "";

  const removed: string[] = [];
  for (const id of Object.keys(accounts)) {
    if (id === "main") continue;
    const entry = accounts[id];
    const entryToken =
      typeof entry?.botToken === "string" ? entry.botToken.trim() : "";
    const hasChatId =
      (typeof entry?.chatId === "string" && entry.chatId.trim().length > 0) ||
      typeof entry?.chatId === "number";
    const sharesByMeta = !!metaMap[id]?.shares_bot_with;

    // Strip if either: meta says it shares OR it duplicates main's token
    // without an independent chatId.
    const shouldStrip =
      !hasChatId && (sharesByMeta || (mainToken && entryToken === mainToken));
    if (shouldStrip) {
      delete accounts[id];
      removed.push(id);
    }
  }
  return removed;
}

/**
 * Self-heal: drop entries from `channels.telegram.accounts` that have no
 * real botToken. They are leftovers from the historical bug where saving
 * a new agent created `{ dmPolicy: "pairing" }` entries without ever
 * setting a token — OpenClaw routed messages to those accounts (because
 * account id matches agent id) and silently failed to authenticate,
 * which manifested as "bot: inválido" in the integrations panel and the
 * bot ghosting messages from chats bound to that agent.
 *
 * "configured_mock_token" is the placeholder some older flows wrote and
 * we also treat as effectively-empty.
 */
function stripTokenlessTelegramAccounts(config: any): string[] {
  const accounts = config?.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const removed: string[] = [];
  for (const id of Object.keys(accounts)) {
    const entry = accounts[id];
    const token = typeof entry?.botToken === "string" ? entry.botToken.trim() : "";
    if (!token || token === "configured_mock_token") {
      delete accounts[id];
      removed.push(id);
    }
  }
  return removed;
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
  /**
   * Telegram bot status surfaced to the UI:
   *   - "configured" → this agent owns its own bot account
   *   - "shared"     → this agent rides on another agent's bot (see `shares_bot_with`)
   *   - undefined    → no Telegram setup
   */
  botToken?: "configured" | "shared";
  shares_bot_with?: string;
  status: "online" | "offline";
  lastActivity?: string;
  activeSessions: number;
  // Multi-agent orchestration meta (stored locally, not in openclaw.json)
  role: AgentRole;
  specialty: string[];
  inherit_jarvis_skills: boolean;
  override_autonomous: AgentAutonomousOverride;
  cost_caps: AgentCostCaps;
  template_id?: string;
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
    // Self-heal: drop tokenless channels.telegram.accounts entries created
    // by the historical agent-form bug (see stripTokenlessTelegramAccounts
    // docstring). This is what stops the bot from responding after the
    // user adds a second agent.
    const removedAccounts = stripTokenlessTelegramAccounts(config);
    // Self-heal: drop "phantom" sub-agent accounts that mirror main's bot
    // token without their own chatId (the v1 shareBotWith bug). Reads meta
    // so we strip even when the AtlasDeck local file already records the
    // shares_bot_with relationship but the openclaw.json still has the
    // duplicate entry.
    const allMetaForStrip = getAllAgentMeta();
    const removedSubAccounts = stripSubAgentTelegramAccounts(config, allMetaForStrip);
    // Self-heal: clamp dmPolicy to canonical values (pairing/open/off).
    // Anything else (e.g. "allowlist") makes OpenClaw silently drop DMs.
    const fixedDmPolicies = normalizeTelegramDmPolicies(config);
    if (
      uiMigrated ||
      bindingsStripped ||
      removedAccounts.length > 0 ||
      removedSubAccounts.length > 0 ||
      fixedDmPolicies.length > 0
    ) {
      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        const what = [
          uiMigrated && "ui→local",
          bindingsStripped && "stripped invalid agents.bindings",
          removedAccounts.length > 0 &&
            `removed tokenless telegram accounts (${removedAccounts.join(", ")})`,
          removedSubAccounts.length > 0 &&
            `removed phantom sub-agent accounts (${removedSubAccounts.join(", ")})`,
          fixedDmPolicies.length > 0 &&
            `clamped invalid dmPolicy → pairing (${fixedDmPolicies.join(", ")})`,
        ]
          .filter(Boolean)
          .join(" + ");
        logActivity("config", `Migração openclaw.json: ${what}`, "success", {
          metadata: { configPath, removedAccounts, removedSubAccounts, fixedDmPolicies },
        });
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

      const meta = getAgentMeta(agent.id);
      // Bot status surfaced to the UI: "configured" (owns bot), "shared"
      // (rides on parent's bot via shares_bot_with), or undefined (no
      // Telegram setup). The UI uses this to show "via @main" badges
      // without ever holding the raw token.
      const botTokenStatus: "configured" | "shared" | undefined = botToken
        ? "configured"
        : meta.shares_bot_with
        ? "shared"
        : undefined;

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
        botToken: botTokenStatus,
        shares_bot_with: meta.shares_bot_with,
        status,
        lastActivity,
        activeSessions: 0,
        role: meta.role!,
        specialty: meta.specialty ?? [],
        inherit_jarvis_skills: meta.inherit_jarvis_skills ?? true,
        override_autonomous: meta.override_autonomous ?? "inherit",
        cost_caps: meta.cost_caps ?? {},
        template_id: meta.template_id,
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

    // Orchestration metadata (role, specialty, inherit_jarvis_skills,
    // override_autonomous, cost_caps, template_id) also lives outside
    // openclaw.json to keep its strict schema clean.
    setAgentMeta(body.id, {
      role: body.role,
      specialty: Array.isArray(body.specialty) ? body.specialty : undefined,
      inherit_jarvis_skills:
        typeof body.inherit_jarvis_skills === "boolean" ? body.inherit_jarvis_skills : undefined,
      override_autonomous: body.override_autonomous,
      cost_caps: body.cost_caps,
      template_id: body.template_id,
    });

    config.agents.list.push(newAgent);

    // Telegram config: merge, NEVER replace. Older code rewrote the entire
    // accounts[id] object even when the user didn't touch the Telegram fields,
    // wiping a previously-saved botToken/chatId.
    //
    // BUG FIX: We used to CREATE a new accounts[id] entry just because the
    // form sent the default dmPolicy="pairing" — even when no bot token was
    // ever provided. That produced tokenless entries like
    //   "channels.telegram.accounts.main": { "dmPolicy": "pairing" }
    // which OpenClaw routed to (account-id == agent-id) and then failed to
    // authenticate because there was no botToken. The visible symptom was
    // every newly-created agent showing "bot: inválido" and the bot
    // silently stopping to respond on Telegram.
    //
    // New rule: ONLY touch channels.telegram.accounts[id] when the caller
    // provided a real bot token. dmPolicy without a token is meaningless
    // anyway — the channel-level default (channels.telegram.dmPolicy) is
    // applied at read-time when no account-level override exists.
    //
    // `shareBotWith` is a server-side shortcut that lets the agent form
    // create a sub-agent reusing the SAME bot as another existing agent
    // without the token ever crossing back through the browser. The
    // backend copies channels.telegram.accounts[shareBotWith].botToken
    // into the new account so the operator can spin up linked agents
    // ("dev", "vendas", ...) all answering through the @main_bot.
    // Resolve telegram setup. Three paths:
    //  (a) shareBotWith → DON'T write to channels.telegram.accounts; record
    //      the relationship in agents-meta only. OpenClaw sees one account
    //      (main's), all incoming messages route to main, Jarvis delegates
    //      internally via `delegate_to`. This was the source of the
    //      "criou agente → telegram parou" regression.
    //  (b) explicit botToken in the form → write a real, independent
    //      account entry. This is the case for an agent that owns its own
    //      bot.
    //  (c) neither → no Telegram setup, no entry written.
    const shareBotWith =
      typeof body.shareBotWith === "string" && body.shareBotWith.trim()
        ? body.shareBotWith.trim()
        : null;
    if (shareBotWith) {
      const sourceAccount = config.channels?.telegram?.accounts?.[shareBotWith];
      const sourceToken =
        typeof sourceAccount?.botToken === "string" ? sourceAccount.botToken.trim() : "";
      if (!sourceToken) {
        return NextResponse.json(
          {
            error: `shareBotWith="${shareBotWith}": agente fonte não tem botToken configurado. Configure o bot do "${shareBotWith}" primeiro (Telegram Setup) e tente novamente.`,
          },
          { status: 400 },
        );
      }
      // Path (a): record the relationship — DO NOT pollute openclaw.json.
      setAgentMeta(body.id, { shares_bot_with: shareBotWith });
    } else if (
      typeof body.botToken === "string" &&
      body.botToken.trim() &&
      body.botToken !== "configured"
    ) {
      // Path (b): independent bot for this agent.
      const resolvedToken = body.botToken.trim();
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};

      const existingAccount = config.channels.telegram.accounts[body.id] || {};
      const nextAccount = { ...existingAccount, botToken: resolvedToken };
      const hasIncomingDmPolicy = typeof body.dmPolicy === "string" && body.dmPolicy.trim();
      if (hasIncomingDmPolicy) nextAccount.dmPolicy = body.dmPolicy;
      config.channels.telegram.accounts[body.id] = nextAccount;
      // Clear any prior shares_bot_with so the UI shows the right state.
      setAgentMeta(body.id, { shares_bot_with: "" });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    try {
      logActivity("agent", `Agente criado: ${newAgent.name} (${newAgent.id})`, "success", {
        agent: newAgent.id,
        metadata: { id: newAgent.id, model: newAgent.model?.primary, workspace: newAgent.workspace },
      });
    } catch {}
    // Swarm changed — regenerate the orchestrator memory block so Jarvis
    // sees the new sub-agent on its next session boot.
    void refreshOrchestratorsBestEffort(config.agents.list);
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
    // Orchestration metadata — partial update, only patches fields actually
    // sent. Keeps role/specialty/etc. out of openclaw.json's strict schema.
    if (
      body.role !== undefined ||
      body.specialty !== undefined ||
      body.inherit_jarvis_skills !== undefined ||
      body.override_autonomous !== undefined ||
      body.cost_caps !== undefined ||
      body.template_id !== undefined
    ) {
      setAgentMeta(body.id, {
        role: body.role,
        specialty: Array.isArray(body.specialty) ? body.specialty : undefined,
        inherit_jarvis_skills:
          typeof body.inherit_jarvis_skills === "boolean" ? body.inherit_jarvis_skills : undefined,
        override_autonomous: body.override_autonomous,
        cost_caps: body.cost_caps,
        template_id: body.template_id,
      });
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
    // including the tokenless-entry bug: dmPolicy alone never creates an
    // account entry. To save dmPolicy for an agent, use the TelegramSetupModal
    // (which saves it next to a real botToken).
    // `shareBotWith` follows the same shape as POST — used to switch a
    // sub-agent over to share the parent's bot without re-typing the token.
    // Same three-path resolution as POST — see POST handler for context.
    // shareBotWith → meta only (no channels.telegram.accounts entry).
    // Independent botToken → write a real account.
    // Neither → leave Telegram config alone (dmPolicy edits only land when
    // a real account already exists).
    const putShareBotWith =
      typeof body.shareBotWith === "string" && body.shareBotWith.trim()
        ? body.shareBotWith.trim()
        : null;
    const putHasIncomingTokenInput =
      typeof body.botToken === "string" && body.botToken.trim() && body.botToken !== "configured";
    const putHasIncomingDmPolicy = typeof body.dmPolicy === "string" && body.dmPolicy.trim();

    const existingAccount = config.channels?.telegram?.accounts?.[body.id];
    if (putShareBotWith) {
      // Path (a): switch this agent to ride on the parent's bot. Validate
      // the parent has a real token, then record the relationship in meta
      // and (defensively) strip any phantom entry we may already have for
      // this sub-agent — that's exactly the duplicate-entry scenario that
      // broke routing in the first place.
      const sourceAccount = config.channels?.telegram?.accounts?.[putShareBotWith];
      const sourceToken =
        typeof sourceAccount?.botToken === "string" ? sourceAccount.botToken.trim() : "";
      if (!sourceToken) {
        return NextResponse.json(
          { error: `shareBotWith="${putShareBotWith}": agente fonte não tem botToken configurado.` },
          { status: 400 },
        );
      }
      setAgentMeta(body.id, { shares_bot_with: putShareBotWith });
      if (config.channels?.telegram?.accounts?.[body.id]) {
        // Only delete if it's a phantom (no independent chatId).
        const phantomToken =
          typeof config.channels.telegram.accounts[body.id]?.botToken === "string"
            ? config.channels.telegram.accounts[body.id].botToken.trim()
            : "";
        const phantomChat = config.channels.telegram.accounts[body.id]?.chatId;
        if (!phantomChat && phantomToken === sourceToken) {
          delete config.channels.telegram.accounts[body.id];
        }
      }
    } else if (putHasIncomingTokenInput) {
      // Path (b): independent bot for this agent.
      const putResolvedToken = body.botToken.trim();
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
      if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};

      const cur = config.channels.telegram.accounts[body.id] || {};
      const nextAccount = { ...cur, botToken: putResolvedToken };
      if (putHasIncomingDmPolicy) nextAccount.dmPolicy = body.dmPolicy;
      config.channels.telegram.accounts[body.id] = nextAccount;
      // Clear any prior shares_bot_with — agent now owns its bot.
      setAgentMeta(body.id, { shares_bot_with: "" });
    } else if (
      putHasIncomingDmPolicy &&
      existingAccount &&
      typeof existingAccount.botToken === "string" &&
      existingAccount.botToken.trim()
    ) {
      // Only let dmPolicy edits land when an account ALREADY exists with a
      // real token. Without this guard, an edit-modal save would create the
      // same tokenless entry as the POST bug above.
      existingAccount.dmPolicy = body.dmPolicy;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    try {
      const changed = Object.keys(body).filter((k) => k !== "id");
      logActivity("agent", `Agente atualizado: ${agent.name} (${body.id})`, "success", {
        agent: body.id,
        metadata: { id: body.id, fields: changed },
      });
    } catch {}
    void refreshOrchestratorsBestEffort(config.agents.list);
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
    // Clean orchestration metadata (role, specialty, cost caps, etc.)
    deleteAgentMeta(id);

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
    void refreshOrchestratorsBestEffort(config.agents.list);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
