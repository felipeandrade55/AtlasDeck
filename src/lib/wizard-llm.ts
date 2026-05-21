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

const execFileAsync = promisify(execFile);
const OPENCLAW_TIMEOUT_MS = 60_000;
const OPENCLAW_MAX_BUFFER = 4 * 1024 * 1024;

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

async function tryOpenClaw(prompt: string): Promise<string | null> {
  const config = readOpenClawConfig();
  const overrideCmd = process.env.MEMORY_EXTRACTION_CMD;
  const candidates: string[][] = overrideCmd
    ? [overrideCmd.split(" ")]
    : [
        ["ask", "--json", "--prompt", prompt],
        ["chat", "--json", prompt],
        ["complete", "--json", prompt],
      ];

  for (const args of candidates) {
    try {
      const { stdout } = await execFileAsync(config.openclawBin, args, {
        timeout: OPENCLAW_TIMEOUT_MS,
        maxBuffer: OPENCLAW_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DIR: config.openclawDir,
          OPENCLAW_WORKSPACE: config.openclawWorkspace,
        },
      });
      const cleaned = String(stdout).trim();
      if (cleaned) return cleaned;
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
  opts: { preferred?: WizardProvider; ollamaModel?: string } = {},
): Promise<WizardLLMResult<T>> {
  const settings = getSettings();
  const preferred =
    opts.preferred ??
    (settings.extractor_provider === "openclaw" ? "openclaw" : "ollama");
  const ollamaModel = opts.ollamaModel ?? settings.ollama_model;

  let raw: string | null = null;
  let provider: WizardProvider = preferred;
  let model = preferred === "ollama" ? ollamaModel : "openclaw";

  if (preferred === "ollama") {
    raw = await tryOllama(prompt, ollamaModel);
    if (!raw) {
      raw = await tryOpenClaw(prompt);
      provider = "openclaw";
      model = "openclaw";
    }
  } else {
    raw = await tryOpenClaw(prompt);
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
