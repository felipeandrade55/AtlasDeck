/**
 * Wizard LLM glue.
 *
 * The onboarding wizard talks to a local Ollama model by default (no
 * cost) and falls back to the OpenClaw CLI if Ollama isn't available.
 * Same JSON-strict contract regardless of provider so the wizard
 * routes don't care which one served the request.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { generateJson as ollamaGenerateJson, getOllamaStatus } from "@/lib/ollama-client";
import { getSettings } from "@/lib/memory-db";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { parseAgentEnvelope } from "@/lib/openclaw-runner";
import { buildProviderEnv } from "@/lib/provider-keys";

const execFileAsync = promisify(execFile);
// Total time the CLI is allowed to burn across all attempts. Bounds a
// wedged/unconfigured CLI so it can't hang the wizard for minutes — the
// caller passes a tighter budget for the interview (fast) than for
// generation (a real model legitimately takes longer).
const OPENCLAW_DEFAULT_BUDGET_MS = 45_000;
const OPENCLAW_MAX_BUFFER = 4 * 1024 * 1024;

// The conversational CLI is `openclaw agent` — the SAME path the chat
// runner drives, which goes through the gateway where the user's model
// credentials (API key or OAuth/Codex login) are already loaded. The
// old `ask`/`chat`/`complete` subcommands don't exist in current builds,
// which is why the wizard never reached the configured model.
const WIZARD_AGENT = process.env.MEMORY_WIZARD_AGENT || "main";
const WIZARD_CHANNEL = process.env.ATLAS_CHAT_TO || "web:atlasdeck";

export type WizardProvider = "ollama" | "openclaw";

export interface WizardLLMResult<T = unknown> {
  data: T;
  provider: WizardProvider;
  model: string;
}

function extractJsonObject(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function tryOllama(prompt: string, model: string): Promise<string | null> {
  try {
    const status = await getOllamaStatus();
    if (!status.running) return null;
    const out = await ollamaGenerateJson(model, prompt, {
      temperature: 0.4,
      maxTokens: 2048,
    });
    return out;
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[wizard-llm] Ollama call failed:", err);
    }
    return null;
  }
}

async function tryOpenClaw(
  prompt: string,
  budgetMs = OPENCLAW_DEFAULT_BUDGET_MS,
): Promise<string | null> {
  const config = readOpenClawConfig();
  const overrideCmd = process.env.MEMORY_EXTRACTION_CMD;
  const candidates: string[][] = overrideCmd
    ? [overrideCmd.split(" ")]
    : [
        // Canonical: one agent turn through the gateway, JSON envelope out.
        ["agent", "--agent", WIZARD_AGENT, "--message", prompt, "--to", WIZARD_CHANNEL, "--json"],
        // Legacy shapes, kept only as a fallback for older CLI builds.
        ["ask", "--json", "--prompt", prompt],
        ["chat", "--json", prompt],
      ];

  const deadline = Date.now() + budgetMs;
  for (const args of candidates) {
    const remaining = deadline - Date.now();
    // Out of budget — bail instead of waiting on the next candidate.
    // Keeps a wedged or unconfigured CLI from stacking N×timeouts.
    if (remaining <= 0) break;
    try {
      const { stdout } = await execFileAsync(config.openclawBin, args, {
        timeout: remaining,
        maxBuffer: OPENCLAW_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          // Provider API keys (Anthropic/OpenAI/Google) so the agent
          // subprocess inherits credentials the gateway might also need.
          ...buildProviderEnv(),
          OPENCLAW_DIR: config.openclawDir,
          OPENCLAW_WORKSPACE: config.openclawWorkspace,
        },
      });
      const cleaned = String(stdout).trim();
      if (!cleaned) continue;
      // `agent --json` wraps the reply in an envelope; pull the visible
      // text out. Legacy/override commands print text directly, in which
      // case parseAgentEnvelope returns reply=null and we use raw stdout.
      const reply = parseAgentEnvelope(cleaned).reply;
      return reply ?? cleaned;
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn(`[wizard-llm] OpenClaw ${args[0]} failed:`, err);
      }
    }
  }
  return null;
}

/**
 * Run a JSON-mode prompt against whichever provider is available.
 * Honours user preference (memory_settings.extractor_provider) but
 * gracefully falls back if the preferred one is unreachable.
 */
export async function runWizardLLM<T>(
  prompt: string,
  opts: { preferred?: WizardProvider; ollamaModel?: string; timeoutMs?: number } = {},
): Promise<WizardLLMResult<T>> {
  const settings = getSettings();
  const preferred =
    opts.preferred ??
    (settings.extractor_provider === "openclaw" ? "openclaw" : "ollama");
  const ollamaModel = opts.ollamaModel ?? settings.ollama_model;
  const budgetMs = opts.timeoutMs ?? OPENCLAW_DEFAULT_BUDGET_MS;

  let raw: string | null = null;
  let provider: WizardProvider = preferred;
  let model = preferred === "ollama" ? ollamaModel : "openclaw";

  if (preferred === "ollama") {
    raw = await tryOllama(prompt, ollamaModel);
    if (!raw) {
      raw = await tryOpenClaw(prompt, budgetMs);
      provider = "openclaw";
      model = "openclaw";
    }
  } else {
    raw = await tryOpenClaw(prompt, budgetMs);
    if (!raw) {
      raw = await tryOllama(prompt, ollamaModel);
      provider = "ollama";
      model = ollamaModel;
    }
  }

  if (!raw) {
    throw new Error(
      "Nenhum provider de LLM respondeu. Verifique se o Ollama está rodando ou o OpenClaw CLI configurado.",
    );
  }

  const jsonText = extractJsonObject(raw) ?? raw;
  let parsed: T;
  try {
    parsed = JSON.parse(jsonText) as T;
  } catch (err) {
    throw new Error(
      `LLM retornou JSON inválido: ${(err as Error).message}. Resposta: ${raw.slice(0, 200)}`,
    );
  }
  return { data: parsed, provider, model };
}
