/**
 * Setup status — single source of truth for the welcome wizard.
 *
 * Aggregates four health checks (OpenClaw install, interview files,
 * AI provider config, Telegram account) plus the persisted setup step
 * pointer. Cheap enough to poll every few seconds while a step runs.
 */
import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { detectOpenClaw } from "@/lib/openclaw-installer";
import { getSettings, setSettings } from "@/lib/memory-db";
import { resolveOpenClawAgentsConfigPath, getOpenClawWorkspace } from "@/lib/openclaw-config";
import { listProviderKeys, type ProviderId } from "@/lib/provider-keys";
import { getTelegramAccountLocal } from "@/lib/telegram-accounts-local";
import { getOllamaStatus } from "@/lib/ollama-client";
import { countAccounts as countEmailAccounts } from "@/lib/email-store";

export const dynamic = "force-dynamic";

interface ConfigShape {
  agents?: { list?: Array<{ id: string; model?: { primary?: string } }> };
  channels?: {
    telegram?: {
      accounts?: Record<string, { botToken?: string }>;
    };
  };
}

function inferProvider(modelId: string | null): ProviderId | "ollama" | "openclaw-codex" | "unknown" {
  if (!modelId) return "unknown";
  const lower = modelId.toLowerCase();
  if (lower.startsWith("anthropic/") || lower.includes("claude")) return "anthropic";
  if (lower.startsWith("openai/codex") || lower.includes("-codex")) return "openclaw-codex";
  if (lower.startsWith("openai/") || lower.startsWith("gpt-")) return "openai";
  if (lower.startsWith("google/") || lower.includes("gemini")) return "google";
  if (lower.startsWith("ollama/")) return "ollama";
  return "unknown";
}

export async function GET() {
  const settings = getSettings();

  // 1. OpenClaw install
  const detected = await detectOpenClaw();
  const installed = !!detected;

  // 2. Interview files
  const workspace = getOpenClawWorkspace();
  const memoryDir = join(workspace, "memory");
  const interview = {
    done: settings.llm_choice_made,
    hasIdentity: existsSync(join(memoryDir, "IDENTITY.md")),
    hasSoul: existsSync(join(memoryDir, "SOUL.md")),
    hasUser: existsSync(join(memoryDir, "USER.md")),
  };
  const interviewComplete =
    interview.done && interview.hasIdentity && interview.hasSoul && interview.hasUser;

  // 3. AI provider
  let config: ConfigShape = {};
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    config = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigShape;
  } catch {
    // fallback path may not exist yet — leave config empty
  }
  const firstAgent = config.agents?.list?.[0] ?? null;
  const primaryModel = firstAgent?.model?.primary ?? null;
  const provider = inferProvider(primaryModel);
  const keys = listProviderKeys();
  const cloudKeyMap = new Map(keys.map((k) => [k.provider, k.hasKey]));

  let ollamaSummary: { installed: boolean; running: boolean; modelsCount: number } = {
    installed: false,
    running: false,
    modelsCount: 0,
  };
  try {
    const status = await getOllamaStatus();
    ollamaSummary = {
      installed: status.installed,
      running: status.running,
      modelsCount: status.models.length,
    };
  } catch {
    // ollama may not be installed — treat as offline
  }

  const aiConfigured = (() => {
    if (!primaryModel) return false;
    if (provider === "anthropic" || provider === "openai" || provider === "google") {
      return cloudKeyMap.get(provider) === true;
    }
    if (provider === "ollama") {
      return ollamaSummary.running && ollamaSummary.modelsCount > 0;
    }
    if (provider === "openclaw-codex") {
      // Codex OAuth lives outside our key store; presence of model + bin is enough.
      return installed;
    }
    return installed; // unknown / custom — trust the operator
  })();

  // 4. Telegram
  const accounts = config.channels?.telegram?.accounts ?? {};
  const accountIds = Object.keys(accounts);
  const primaryAccountId = accountIds[0] ?? "main";
  const primaryAccount = accounts[primaryAccountId];
  const hasToken =
    !!primaryAccount?.botToken &&
    primaryAccount.botToken.trim().length > 0 &&
    primaryAccount.botToken !== "configured_mock_token";
  const chatId = getTelegramAccountLocal(primaryAccountId).chatId ?? null;
  const telegramConnected = hasToken && !!chatId;

  // 5. Email — optional step. AtlasDeck owns IMAP/SMTP directly now;
  // accounts live in data/email-accounts.json.
  const emailAccountCount = countEmailAccounts();
  const emailSkipped = settings.setup_email_skipped;
  const emailDone = emailAccountCount > 0 || emailSkipped;

  // 6. Compute the suggested step pointer (auto-advances persisted step
  // if the user fixed earlier steps out of band)
  let suggestedStep = settings.setup_step;
  if (settings.setup_completed_at) {
    suggestedStep = "done";
  } else if (!installed) {
    suggestedStep = "install";
  } else if (!aiConfigured) {
    suggestedStep = "ai";
  } else if (!interviewComplete) {
    suggestedStep = "interview";
  } else if (!telegramConnected) {
    suggestedStep = "telegram";
  } else if (!emailDone) {
    suggestedStep = "email";
  } else {
    suggestedStep = "done";
  }

  if (suggestedStep !== settings.setup_step) {
    setSettings({ setup_step: suggestedStep });
  }

  return NextResponse.json({
    setup: {
      step: suggestedStep,
      completedAt: settings.setup_completed_at,
    },
    openclaw: {
      installed,
      binPath: detected?.binPath ?? null,
      version: detected?.version ?? null,
      workspace,
    },
    interview: {
      ...interview,
      complete: interviewComplete,
    },
    ai: {
      primaryModel,
      provider,
      configured: aiConfigured,
      cloudKeys: keys.map((k) => ({
        provider: k.provider,
        hasKey: k.hasKey,
        masked: k.masked,
      })),
      ollama: ollamaSummary,
    },
    telegram: {
      connected: telegramConnected,
      accountId: primaryAccountId,
      hasToken,
      hasChatId: !!chatId,
    },
    email: {
      accountCount: emailAccountCount,
      skipped: emailSkipped,
    },
  });
}
