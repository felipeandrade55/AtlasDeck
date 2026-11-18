/**
 * Wizard LLM glue.
 *
 * The onboarding wizard talks to a local Ollama model by default (no
 * cost) and falls back to the OpenClaw CLI if Ollama isn't available.
 * Same JSON-strict contract regardless of provider so the wizard
 * routes don't care which one served the request.
 */
import { generateJson as ollamaGenerateJson, getOllamaStatus } from "@/lib/ollama-client";
import { getSettings } from "@/lib/memory-db";
import { runOneShotJson } from "@/lib/llm-oneshot";

// Total time the CLI is allowed to burn. Bounds a wedged/unconfigured CLI
// so it can't hang the wizard for minutes — the caller passes a tighter
// budget for the interview (fast) than for generation.
const OPENCLAW_DEFAULT_BUDGET_MS = 45_000;

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
  // Shared one-shot path (infer → agent fallback, serialized, breaker).
  // `infer` doesn't touch the user's web session the way the old
  // `agent --to web:atlasdeck` call did.
  try {
    const { data } = await runOneShotJson<Record<string, unknown>>(prompt, {
      purpose: "wizard",
      timeoutMs: budgetMs,
      validate: (v): v is Record<string, unknown> => Boolean(v) && typeof v === "object",
    });
    return JSON.stringify(data);
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[wizard-llm] OpenClaw one-shot failed:", err);
    }
    return null;
  }
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
