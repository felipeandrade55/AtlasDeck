/**
 * Ollama integration: lets the memory extractor call a local LLM
 * (Qwen, Gemma, Llama, etc.) instead of OpenClaw's paid cloud models.
 *
 * Ollama runs as a daemon listening on http://localhost:11434 with a
 * simple HTTP API. We:
 *   - detect whether it's installed + running
 *   - list local models
 *   - stream `pull` progress (downloading a model is ~minutes)
 *   - run `generate` with JSON-formatted responses
 *
 * All HTTP — no shell exec needed for runtime use. Shell is only
 * invoked when the user clicks "Install Ollama" in the UI.
 */
import { exec as _exec, spawn } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

const exec = promisify(_exec);
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT_MS = 60_000;

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  baseUrl: string;
  models: OllamaModel[];
  platform: NodeJS.Platform;
  installHint: string;
}

const PLATFORM_HINT: Record<string, string> = {
  linux: "curl -fsSL https://ollama.com/install.sh | sh",
  darwin: "https://ollama.com/download/mac — baixe o app .dmg",
  win32: "https://ollama.com/download/windows — baixe o instalador .exe",
};

async function ollamaFetch(
  pathSuffix: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? OLLAMA_TIMEOUT_MS,
  );
  try {
    return await fetch(`${OLLAMA_BASE_URL}${pathSuffix}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function detectInstalledBinary(): Promise<string | null> {
  try {
    const { stdout } = await exec("ollama --version", { timeout: 5_000 });
    return String(stdout).trim() || "unknown";
  } catch {
    return null;
  }
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  const platform = process.platform;
  const installHint =
    PLATFORM_HINT[platform] || "https://ollama.com/download";

  let version: string | null = null;
  let installed = false;
  try {
    version = await detectInstalledBinary();
    installed = version !== null;
  } catch {
    installed = false;
  }

  let running = false;
  let models: OllamaModel[] = [];
  try {
    const res = await ollamaFetch("/api/tags", { timeoutMs: 4_000 });
    if (res.ok) {
      running = true;
      const data = (await res.json()) as { models?: OllamaModel[] };
      models = data.models ?? [];
    }
  } catch {
    running = false;
  }

  return {
    installed,
    running,
    version,
    baseUrl: OLLAMA_BASE_URL,
    models,
    platform,
    installHint,
  };
}

/**
 * Pull a model. Streams Ollama's progress events to the provided
 * callback. The full operation takes minutes (model size dependent).
 *
 * Returns a Promise that resolves once Ollama signals completion.
 */
export async function pullModel(
  model: string,
  onProgress?: (event: {
    status: string;
    total?: number;
    completed?: number;
    digest?: string;
  }) => void,
): Promise<void> {
  const res = await ollamaFetch("/api/pull", {
    method: "POST",
    body: JSON.stringify({ model, stream: true }),
    timeoutMs: 10 * 60_000,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama pull failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        onProgress?.(event);
        if (event.error) throw new Error(`Ollama: ${event.error}`);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
}

/**
 * Run a single non-streaming generation. Used by the extractor.
 * Forces JSON-mode output via `format: "json"`.
 */
export async function generateJson(
  model: string,
  prompt: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await ollamaFetch("/api/generate", {
    method: "POST",
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: opts.temperature ?? 0.2,
        num_predict: opts.maxTokens ?? 1024,
      },
    }),
    timeoutMs: 5 * 60_000,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama generate failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

export interface ChatStreamMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamEvent {
  delta?: string;
  done?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

/**
 * Stream a conversational completion via Ollama's `/api/chat`. Yields
 * one event per chunk so the caller can forward tokens to the browser
 * in real time. The final event carries usage counts derived from
 * Ollama's `prompt_eval_count` / `eval_count`.
 */
export async function* streamChat(
  model: string,
  messages: ChatStreamMessage[],
  opts: { temperature?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ChatStreamEvent> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.7,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    opts.signal?.removeEventListener("abort", onAbort);
    throw err;
  }

  if (!res.ok || !res.body) {
    opts.signal?.removeEventListener("abort", onAbort);
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama chat failed (HTTP ${res.status}): ${txt.slice(0, 240)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const msg = parsed.message as { content?: string } | undefined;
        const delta = typeof msg?.content === "string" ? msg.content : "";
        if (delta) yield { delta };
        if (parsed.done === true) {
          yield {
            done: true,
            tokensIn: Number(parsed.prompt_eval_count ?? 0),
            tokensOut: Number(parsed.eval_count ?? 0),
            model: typeof parsed.model === "string" ? parsed.model : model,
          };
          return;
        }
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Trigger the official Ollama install script (Linux only). Returns a
 * status id the UI can poll. macOS and Windows users should be
 * directed to the download page since their installs use GUI installers.
 *
 * Security note: this just runs the documented `curl | sh` from
 * ollama.com. Same trust assumption as installing Ollama manually.
 */
const installRuns = new Map<
  string,
  {
    status: "running" | "ok" | "fail";
    logs: string[];
    startedAt: number;
    finishedAt?: number;
    error?: string;
  }
>();

export function startInstall(): { id: string; supported: boolean; hint: string } {
  const platform = process.platform;
  if (platform !== "linux") {
    return {
      id: "",
      supported: false,
      hint:
        PLATFORM_HINT[platform] ||
        "https://ollama.com/download — siga as instruções para o seu SO",
    };
  }

  const id = randomUUID();
  installRuns.set(id, {
    status: "running",
    logs: [],
    startedAt: Date.now(),
  });

  const child = spawn("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
    env: process.env,
  });

  child.stdout.on("data", (chunk) => {
    const entry = installRuns.get(id);
    if (entry) entry.logs.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    const entry = installRuns.get(id);
    if (entry) entry.logs.push(String(chunk));
  });
  child.on("error", (err) => {
    const entry = installRuns.get(id);
    if (entry) {
      entry.status = "fail";
      entry.error = err.message;
      entry.finishedAt = Date.now();
    }
  });
  child.on("close", (code) => {
    const entry = installRuns.get(id);
    if (entry) {
      entry.status = code === 0 ? "ok" : "fail";
      if (code !== 0) entry.error = `install script exit ${code}`;
      entry.finishedAt = Date.now();
    }
  });

  return { id, supported: true, hint: "" };
}

export function getInstallStatus(id: string) {
  const entry = installRuns.get(id);
  if (!entry) return null;
  return {
    status: entry.status,
    logs: entry.logs.join("").slice(-4000), // last 4KB
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt ?? null,
    error: entry.error ?? null,
  };
}

/**
 * Service control via systemd (Linux only). The official Ollama
 * installer creates `ollama.service` and runs as root or via the
 * service user; we shell out to `systemctl` directly. If AtlasDeck
 * itself is running as a non-root user without sudoers entries for
 * `systemctl <verb> ollama`, the calls will fail with permission
 * errors — that's surfaced to the UI verbatim.
 *
 * macOS/Windows return { supported: false } since Ollama there is a
 * GUI app, not a systemd unit.
 */
export type ServiceAction =
  | "start"
  | "stop"
  | "restart"
  | "enable"
  | "disable"
  | "status";

export interface ServiceResult {
  supported: boolean;
  action: ServiceAction;
  ok: boolean;
  active?: boolean;
  enabled?: boolean;
  message: string;
}

async function runSystemctl(
  verb: string,
  unit = "ollama",
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(`systemctl ${verb} ${unit}`, {
      timeout: 10_000,
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
    };
  }
}

export async function controlService(action: ServiceAction): Promise<ServiceResult> {
  if (process.platform !== "linux") {
    return {
      supported: false,
      action,
      ok: false,
      message:
        "Controle do serviço só está disponível em Linux (systemd). No macOS/Windows o Ollama é um app GUI — use o ícone do app pra iniciar/parar.",
    };
  }

  // "status" is a read; the others are state-changing.
  const verbMap: Record<ServiceAction, string> = {
    start: "start",
    stop: "stop",
    restart: "restart",
    enable: "enable",
    disable: "disable",
    status: "status",
  };
  const verb = verbMap[action];

  const { ok, stdout, stderr } = await runSystemctl(verb);

  // Always probe is-active + is-enabled after the action so the UI
  // gets the new state without a second round-trip.
  const activeRes = await runSystemctl("is-active");
  const enabledRes = await runSystemctl("is-enabled");
  const active = activeRes.stdout === "active";
  const enabled = enabledRes.stdout === "enabled" || enabledRes.stdout === "alias";

  if (!ok) {
    const detail = stderr || stdout || "(systemctl não deu detalhe)";
    return {
      supported: true,
      action,
      ok: false,
      active,
      enabled,
      message: `systemctl ${verb} ollama falhou: ${detail}`,
    };
  }

  return {
    supported: true,
    action,
    ok: true,
    active,
    enabled,
    message:
      action === "status"
        ? `active=${active} enabled=${enabled}`
        : `systemctl ${verb} ollama executado com sucesso`,
  };
}

/**
 * Read-only probe of systemd state. Used by getOllamaStatus so the
 * status endpoint can report whether Ollama is configured to start on
 * boot — separate from whether the daemon is currently running.
 */
export async function getServiceState(): Promise<{
  supported: boolean;
  active: boolean;
  enabled: boolean;
}> {
  if (process.platform !== "linux") {
    return { supported: false, active: false, enabled: false };
  }
  const activeRes = await runSystemctl("is-active");
  const enabledRes = await runSystemctl("is-enabled");
  return {
    supported: true,
    active: activeRes.stdout === "active",
    enabled: enabledRes.stdout === "enabled" || enabledRes.stdout === "alias",
  };
}

/**
 * Recommended models for memory extraction, with conservative RAM
 * estimates. Values are for Q4_K_M quantization.
 */
export interface RecommendedModel {
  name: string;
  label: string;
  family: string;
  paramSize: string;
  diskGB: number;
  ramGB: number;
  quality: "great" | "good" | "fair";
  notes: string;
}

export const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    name: "qwen2.5:7b",
    label: "Qwen 2.5 7B",
    family: "qwen",
    paramSize: "7B",
    diskGB: 4.7,
    ramGB: 8,
    quality: "great",
    notes: "Recomendado. Excelente JSON, multilíngue, equilibra qualidade e RAM.",
  },
  {
    name: "qwen2.5:3b",
    label: "Qwen 2.5 3B",
    family: "qwen",
    paramSize: "3B",
    diskGB: 2.0,
    ramGB: 4,
    quality: "good",
    notes: "Para VPSs com pouca RAM. JSON ainda muito bom.",
  },
  {
    name: "qwen2.5:14b",
    label: "Qwen 2.5 14B",
    family: "qwen",
    paramSize: "14B",
    diskGB: 9.0,
    ramGB: 16,
    quality: "great",
    notes: "Mais raciocínio em extração e reflexão.",
  },
  {
    name: "llama3.2:3b",
    label: "Llama 3.2 3B",
    family: "llama",
    paramSize: "3B",
    diskGB: 2.0,
    ramGB: 4,
    quality: "good",
    notes: "Alternativa rápida e leve, multilíngue.",
  },
  {
    name: "gemma2:9b",
    label: "Gemma 2 9B",
    family: "gemma",
    paramSize: "9B",
    diskGB: 5.4,
    ramGB: 12,
    quality: "great",
    notes: "Forte em texto em PT-BR.",
  },
  {
    name: "gemma4:e4b",
    label: "Gemma 4 e4B",
    family: "gemma",
    paramSize: "e4B",
    diskGB: 9.6,
    ramGB: 12,
    quality: "good",
    notes: "Geração mais recente (edge, 4B efetivos). Multimodal, 128K de contexto, bom PT-BR.",
  },
  {
    name: "gemma4:12b",
    label: "Gemma 4 12B",
    family: "gemma",
    paramSize: "12B",
    diskGB: 7.6,
    ramGB: 16,
    quality: "great",
    notes: "Geração mais recente. Forte raciocínio e PT-BR, 256K de contexto.",
  },
  {
    name: "mistral:7b",
    label: "Mistral 7B",
    family: "mistral",
    paramSize: "7B",
    diskGB: 4.1,
    ramGB: 8,
    quality: "good",
    notes: "Rápido, JSON sólido.",
  },
  {
    name: "phi3:mini",
    label: "Phi-3 Mini (3.8B)",
    family: "phi",
    paramSize: "3.8B",
    diskGB: 2.3,
    ramGB: 4,
    quality: "fair",
    notes: "Ultra leve. Para hosts muito apertados.",
  },
];
