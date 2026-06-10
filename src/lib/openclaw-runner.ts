/**
 * Chat runner with layered fallback.
 *
 * The runner first tries to drive the OpenClaw CLI as a subprocess
 * (several argument shapes since the CLI varies across builds). If
 * every CLI strategy fails — for example because the user's OpenClaw
 * build does not ship a `chat`/`ask`/`complete` subcommand — the
 * runner falls back to Ollama's `/api/chat` streaming endpoint using
 * the model configured in memory settings.
 *
 * That fallback covers the most common production setup where OpenClaw
 * is present for skills/orchestration but the conversational primitive
 * lives in Ollama. The chat UI always receives the same event stream
 * regardless of which provider answered.
 */
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { streamChat as ollamaStreamChat, getOllamaStatus } from "@/lib/ollama-client";
import { getSettings } from "@/lib/memory-db";
import { isWsEnabled, runOpenClawWsChat } from "@/lib/openclaw-ws-client";
import { buildProviderEnv } from "@/lib/provider-keys";

export interface RunnerInput {
  agentId: string;
  prompt: string;
  threadId: string;
  sessionId?: string | null;
  workspace?: string | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  thinking?: string;
  fastMode?: boolean;
  mode?: "openclaw" | "quick";
  /**
   * Prompt to use when the quick (Ollama) path fails and the runner
   * auto-falls back to the OpenClaw gateway. The quick prompt carries
   * QUICK_MODE_HINT ("você não tem tools"), which would cripple the
   * full agent — the route passes the openclaw-flavored prompt here.
   */
  openclawPrompt?: string;
}

export type RunnerProvider = "ws" | "cli" | "ollama";

export type RunnerEvent =
  | { type: "provider"; provider: RunnerProvider; detail?: string }
  | { type: "token"; delta: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; output: string }
  | { type: "session"; sessionId: string }
  | { type: "usage"; tokensIn: number; tokensOut: number; cost?: number; model?: string }
  | { type: "timing"; phase: "handshake" | "hello-ok" | "chat-send" | "first-delta" | "final"; ms: number }
  | { type: "done"; buffered?: boolean }
  | { type: "error"; message: string; code?: string };

interface ArgStrategy {
  label: string;
  args: (input: RunnerInput) => string[];
  /** If true, the prompt is written to stdin instead of being passed as an argument. */
  promptOnStdin?: boolean;
}

/**
 * The canonical OpenClaw conversational CLI is `openclaw agent`, which
 * runs a single turn of the agent (via the Gateway) and prints either a
 * JSON envelope (with `--json`) or plain text. We try a couple of arg
 * shapes because flag spellings have varied across builds.
 *
 * The fully streaming experience lives on the Gateway WebSocket
 * (chat.send / chat.history / chat.abort / chat.inject). That migration
 * is tracked in plan/jarvis-roadmap.md as the next chat-runner upgrade.
 */
function chatChannelTarget(): string {
  return process.env.ATLAS_CHAT_TO || "web:atlasdeck";
}

const DEFAULT_STRATEGIES: ArgStrategy[] = [
  {
    label: "agent-json-session-id",
    args: ({ agentId, sessionId, prompt }) => {
      const a = [
        "agent",
        "--agent",
        agentId,
        "--message",
        prompt,
        "--to",
        chatChannelTarget(),
        "--json",
      ];
      if (sessionId) a.push("--session-id", sessionId);
      return a;
    },
  },
  {
    label: "agent-json-session",
    args: ({ agentId, sessionId, prompt }) => {
      const a = [
        "agent",
        "--agent",
        agentId,
        "--message",
        prompt,
        "--to",
        chatChannelTarget(),
        "--json",
      ];
      if (sessionId) a.push("--session", sessionId);
      return a;
    },
  },
  {
    label: "agent-json-no-session",
    args: ({ agentId, prompt }) => [
      "agent",
      "--agent",
      agentId,
      "--message",
      prompt,
      "--to",
      chatChannelTarget(),
      "--json",
    ],
  },
];

function parseStrategiesFromEnv(): ArgStrategy[] {
  const raw = process.env.ATLAS_CHAT_RUNNER_CMD?.trim();
  if (!raw) return DEFAULT_STRATEGIES;
  // Allow overriding via env: each strategy separated by `|`, args by spaces,
  // placeholders ${agentId}, ${sessionId}, ${prompt}, plus the literal token
  // `<STDIN>` to indicate stdin delivery.
  return raw.split("|").map((line, i) => {
    const tokens = line.trim().split(/\s+/);
    const promptOnStdin = tokens.includes("<STDIN>");
    const cleanTokens = tokens.filter((t) => t !== "<STDIN>");
    return {
      label: `env-${i}`,
      promptOnStdin,
      args: ({ agentId, sessionId, prompt }) =>
        cleanTokens.map((t) =>
          t
            .replace(/\$\{agentId\}/g, agentId)
            .replace(/\$\{sessionId\}/g, sessionId ?? "")
            .replace(/\$\{prompt\}/g, prompt),
        ),
    };
  });
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signaled: boolean;
}

function spawnPromise(
  child: ChildProcessWithoutNullStreams,
  onStdoutChunk: (chunk: string) => void,
  abortSignal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let signaled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = () => {
      signaled = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    abortSignal?.addEventListener("abort", onAbort);

    child.on("error", (err) => {
      abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code, signaled });
    });
  });
}

function isMissingBinary(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * Heuristic: try to interpret a line as a JSON event and translate it to
 * a RunnerEvent. Returns null if the line is not parseable JSON or does
 * not match a known shape — in that case the caller treats it as a token.
 */
function lineToEvent(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const type = String(parsed.type ?? parsed.event ?? "").toLowerCase();

    if (type === "delta" || type === "token" || type === "text") {
      const delta = String(parsed.delta ?? parsed.text ?? parsed.content ?? "");
      if (delta) return { type: "token", delta };
    }
    if (type === "tool_use" || type === "tool_call") {
      return {
        type: "tool_use",
        id: parsed.id != null ? String(parsed.id) : undefined,
        name: String(parsed.name ?? parsed.tool ?? "tool"),
        input: parsed.input ?? parsed.arguments ?? null,
      };
    }
    if (type === "tool_result") {
      return {
        type: "tool_result",
        id: parsed.id != null ? String(parsed.id) : undefined,
        output: String(parsed.output ?? parsed.result ?? parsed.content ?? ""),
      };
    }
    if (type === "session" && parsed.sessionId) {
      return { type: "session", sessionId: String(parsed.sessionId) };
    }
    if (type === "usage" || type === "tokens") {
      return {
        type: "usage",
        tokensIn: Number(parsed.tokensIn ?? parsed.input_tokens ?? 0),
        tokensOut: Number(parsed.tokensOut ?? parsed.output_tokens ?? 0),
        cost: parsed.cost != null ? Number(parsed.cost) : undefined,
        model: parsed.model != null ? String(parsed.model) : undefined,
      };
    }
    if (type === "done" || type === "end" || type === "finish") {
      return { type: "done" };
    }
    if (type === "error") {
      return { type: "error", message: String(parsed.message ?? parsed.error ?? "unknown error") };
    }
    // Unknown JSON shape: if it carries a text-like field, treat as token
    const fallbackText =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.content === "string"
        ? parsed.content
        : null;
    if (fallbackText) return { type: "token", delta: fallbackText };
    return null;
  } catch {
    return null;
  }
}

interface AgentEnvelopeFields {
  reply: string | null;
  sessionId: string | null;
  usage: { tokensIn: number; tokensOut: number; model?: string } | null;
}

/**
 * Parses the JSON envelope emitted by `openclaw agent --json` and
 * extracts the parts the chat UI cares about. The envelope has this
 * shape (abridged):
 *
 *   {
 *     "runId": "...",
 *     "status": "ok",
 *     "result": {
 *       "payloads": [{ "text": "<visible reply>", "mediaUrl": null }],
 *       "meta": {
 *         "agentMeta": {
 *           "sessionId": "...",
 *           "model": "...",
 *           "usage": { "input": N, "output": M, "total": T }
 *         },
 *         "finalAssistantVisibleText": "<visible reply>",
 *         "finalAssistantRawText": "<visible reply>"
 *       }
 *     }
 *   }
 *
 * Both `payloads[0].text` and `meta.finalAssistantVisibleText` carry
 * the same text — we accept either so the parser stays robust across
 * minor envelope tweaks. The function returns sensible nulls when the
 * input is not JSON or does not match the expected shape.
 */
export function parseAgentEnvelope(raw: string): AgentEnvelopeFields {
  const result: AgentEnvelopeFields = { reply: null, sessionId: null, usage: null };
  if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return result;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return result;
  }

  const r = parsed.result as Record<string, unknown> | undefined;
  const meta = r?.meta as Record<string, unknown> | undefined;
  const agentMeta = meta?.agentMeta as Record<string, unknown> | undefined;
  const payloads = r?.payloads as Array<Record<string, unknown>> | undefined;

  // Visible reply: prefer first payload text, then finalAssistantVisibleText,
  // then finalAssistantRawText, then a handful of flat-envelope aliases.
  const firstPayload = Array.isArray(payloads) ? payloads[0] : undefined;
  const candidate =
    (firstPayload && typeof firstPayload.text === "string" && firstPayload.text) ||
    (meta && typeof meta.finalAssistantVisibleText === "string" && meta.finalAssistantVisibleText) ||
    (meta && typeof meta.finalAssistantRawText === "string" && meta.finalAssistantRawText) ||
    (typeof parsed.response === "string" && parsed.response) ||
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.content === "string" && parsed.content) ||
    (typeof parsed.text === "string" && parsed.text) ||
    (typeof parsed.output === "string" && parsed.output) ||
    (typeof parsed.reply === "string" && parsed.reply) ||
    null;
  if (candidate) result.reply = candidate;

  // Session id for follow-up turns
  const sessionId =
    (agentMeta && typeof agentMeta.sessionId === "string" && agentMeta.sessionId) ||
    (meta && typeof meta.sessionId === "string" && meta.sessionId) ||
    (typeof parsed.sessionId === "string" && parsed.sessionId) ||
    null;
  if (sessionId) result.sessionId = sessionId;

  // Token usage from agentMeta.usage (input/output/total) — OpenClaw uses
  // those field names instead of input_tokens/output_tokens.
  const usage = agentMeta?.usage as Record<string, unknown> | undefined;
  if (usage) {
    const tokensIn = Number(usage.input ?? usage.tokensIn ?? usage.input_tokens ?? 0);
    const tokensOut = Number(usage.output ?? usage.tokensOut ?? usage.output_tokens ?? 0);
    if (tokensIn || tokensOut) {
      result.usage = {
        tokensIn,
        tokensOut,
        model: typeof agentMeta?.model === "string" ? agentMeta.model : undefined,
      };
    }
  }

  return result;
}

/**
 * Best-effort chunking for the raw-text fallback path. Splits a buffered
 * string into ~24-char windows so the SSE consumer still sees a streaming
 * cadence even when OpenClaw replied in one shot.
 */
function* chunkText(text: string, size = 24): Iterable<string> {
  let i = 0;
  while (i < text.length) {
    yield text.slice(i, i + size);
    i += size;
  }
}

const TIMEOUT_MS = 120_000;

async function* runOllamaFallback(
  input: RunnerInput,
  reason: string,
): AsyncGenerator<RunnerEvent> {
  let model: string | null = null;
  try {
    const status = await getOllamaStatus();
    if (!status.running) {
      yield {
        type: "error",
        code: "NO_PROVIDER",
        message:
          `OpenClaw CLI nao tem comando de chat (${reason}). ` +
          `Ollama tambem nao esta rodando. Inicie o Ollama (systemctl start ollama) ou ` +
          `configure ATLAS_CHAT_RUNNER_CMD para apontar pro comando correto do OpenClaw.`,
      };
      return;
    }
    const settings = getSettings();
    model = settings.ollama_model || "qwen2.5:7b";
    // Ensure the model is locally available; otherwise surface the issue.
    const hasModel = status.models.some((m) => m.name === model || m.name.startsWith(`${model}:`));
    if (!hasModel && status.models.length > 0) {
      // Use the first available model as a soft fallback.
      model = status.models[0].name;
    } else if (!hasModel) {
      yield {
        type: "error",
        code: "OLLAMA_NO_MODEL",
        message: `Ollama esta rodando mas nao tem nenhum modelo instalado. Rode: ollama pull ${model}`,
      };
      return;
    }
  } catch (err) {
    yield {
      type: "error",
      code: "OLLAMA_STATUS_FAIL",
      message: `Falha ao consultar Ollama: ${(err as Error).message}`,
    };
    return;
  }

  const systemPrompt =
    `Voce e o Jarvis (Atlas), o assistente pessoal do usuario rodando dentro do AtlasDeck. ` +
    `Responda em portugues brasileiro, de forma curta e direta. ` +
    `Quando nao souber, diga que nao sabe.`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...(input.history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user" as const, content: input.prompt },
  ];

  let tokensIn = 0;
  let tokensOut = 0;

  yield { type: "provider", provider: "ollama", detail: model };

  try {
    for await (const evt of ollamaStreamChat(model, messages, { signal: input.signal })) {
      if (evt.delta) yield { type: "token", delta: evt.delta };
      if (evt.done) {
        tokensIn = evt.tokensIn ?? 0;
        tokensOut = evt.tokensOut ?? 0;
        yield {
          type: "usage",
          tokensIn,
          tokensOut,
          model: evt.model ?? model,
        };
      }
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      code: "OLLAMA_STREAM_FAIL",
      message: `Ollama falhou no streaming: ${(err as Error).message}`,
    };
  }
}

/**
 * Real-time chat REQUIRES the Gateway WebSocket — the CLI/Ollama paths
 * are minute-latency fallbacks that defeat the "ei Jarvis"+TTS UX. The
 * default is therefore strict: if WS fails, surface the error to the
 * UI instead of silently dropping to CLI. Opt back into the legacy
 * fallback chain with ATLAS_CHAT_ALLOW_FALLBACK=on (or =cli / =ollama
 * to be explicit about which fallback you want).
 */
function fallbackMode(): "off" | "cli" | "ollama" | "any" {
  const raw = (process.env.ATLAS_CHAT_ALLOW_FALLBACK || "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1" || raw === "any") return "any";
  if (raw === "cli") return "cli";
  if (raw === "ollama") return "ollama";
  return "off";
}

// After a quick-mode (Ollama) failure, skip straight to the gateway for a
// while instead of making EVERY following message pay the first-token
// timeout again. Reset on the next successful Ollama turn.
let ollamaQuickFailedAt = 0;
const OLLAMA_QUICK_COOLDOWN_MS = 10 * 60_000;

export async function* runOpenClawChat(input: RunnerInput): AsyncGenerator<RunnerEvent> {
  if (input.mode === "quick") {
    // Jarvis rápido: try Ollama, but NEVER leave the user hanging. If
    // Ollama errors before producing a single token (not installed, no
    // model, daemon wedged, first-token timeout), fall back transparently
    // to the OpenClaw gateway — the same engine that answers on Telegram —
    // using the openclaw-flavored prompt.
    const inCooldown =
      ollamaQuickFailedAt > 0 &&
      Date.now() - ollamaQuickFailedAt < OLLAMA_QUICK_COOLDOWN_MS;
    if (!inCooldown) {
      let producedToken = false;
      let quickFailure: string | null = null;
      for await (const evt of runOllamaFallback(input, "Jarvis rapido selecionado no /chat")) {
        if (evt.type === "error" && !producedToken) {
          quickFailure = evt.message;
          break;
        }
        if (evt.type === "token") producedToken = true;
        yield evt;
        if (evt.type === "done") {
          ollamaQuickFailedAt = 0;
          return;
        }
      }
      if (!quickFailure) return;
      ollamaQuickFailedAt = Date.now();
      console.warn(
        `[openclaw-runner] Jarvis rápido falhou (${quickFailure.slice(0, 160)}); ` +
          `caindo para o gateway OpenClaw`,
      );
    }
    yield* runGatewayChat({
      ...input,
      prompt: input.openclawPrompt ?? input.prompt,
    });
    return;
  }

  // Allow forcing Ollama via env (kept for backward compat — used during
  // gateway outages or while debugging the runner).
  if (process.env.ATLAS_CHAT_PROVIDER === "ollama") {
    yield* runOllamaFallback(input, "ATLAS_CHAT_PROVIDER=ollama");
    return;
  }

  yield* runGatewayChat(input);
}

/**
 * Gateway-first chat path: WebSocket streaming, with the legacy CLI /
 * Ollama chain available only behind ATLAS_CHAT_ALLOW_FALLBACK.
 */
async function* runGatewayChat(input: RunnerInput): AsyncGenerator<RunnerEvent> {
  const fb = fallbackMode();

  // Strategy 0: Gateway WebSocket — real-time tokens with abort support.
  // When ATLAS_CHAT_ALLOW_FALLBACK is unset we run STRICT: any WS
  // failure becomes a user-visible error instead of an invisible CLI
  // detour that takes 30s+ per turn.
  let wsFailureForCli: string | null = null;
  if (isWsEnabled()) {
    const sessionKey =
      process.env.ATLAS_CHAT_TO ||
      (input.sessionId ? `web:${input.sessionId.slice(0, 24)}` : "web:atlasdeck");

    let producedAny = false;
    let wsFatal: string | null = null;
    let providerAnnounced = false;
    try {
      for await (const evt of runOpenClawWsChat({
        agentId: input.agentId,
        prompt: input.prompt,
        sessionKey,
        sessionId: input.sessionId,
        signal: input.signal,
        thinking: input.thinking,
        fastMode: input.fastMode,
      })) {
        if (evt.type === "error") {
          // First byte never arrived or gateway refused — try the CLI.
          if (
            !producedAny &&
            (evt.code === "WS_HANDSHAKE_TIMEOUT" ||
              evt.code === "WS_CONNECT_FAIL" ||
              evt.code === "NO_WS" ||
              (evt.code ?? "").startsWith("WS_CLOSE_"))
          ) {
            wsFatal = evt.message;
            break;
          }
          if (!providerAnnounced) {
            yield { type: "provider", provider: "ws" };
            providerAnnounced = true;
          }
          producedAny = true;
          yield evt;
          return;
        }
        if (!providerAnnounced) {
          yield { type: "provider", provider: "ws" };
          providerAnnounced = true;
        }
        producedAny = true;
        yield evt;
        if (evt.type === "done") return;
      }
      if (producedAny) return;
    } catch (err) {
      wsFatal = err instanceof Error ? err.message : String(err);
    }

    if (wsFatal) {
      wsFailureForCli = wsFatal;
      if (process.env.MEMORY_DEBUG === "1") {
        console.log(
          `[openclaw-runner] WS unavailable (${wsFatal}); fallback=${fb}`,
        );
      }
      // Strict mode: do NOT fall back to CLI/Ollama. Surface the WS
      // failure directly so the chat UI can show what went wrong
      // (token expired, gateway down, wrong path, etc.).
      if (fb === "off") {
        yield {
          type: "error",
          code: "WS_REQUIRED",
          message:
            `OpenClaw WebSocket falhou: ${wsFatal}. Real-time chat exige WS — ` +
            `confira token e endereço do gateway em Settings, ou ative o fallback ` +
            `legacy com ATLAS_CHAT_ALLOW_FALLBACK=on (CLI/Ollama, latência alta).`,
        };
        return;
      }
    }
  } else {
    wsFailureForCli = "WS disabled via ATLAS_CHAT_WS=off";
    if (fb === "off") {
      yield {
        type: "error",
        code: "WS_DISABLED",
        message:
          "WebSocket está desativado (ATLAS_CHAT_WS=off). Para usar real-time chat " +
          "remova essa variável, ou habilite fallback com ATLAS_CHAT_ALLOW_FALLBACK=on.",
      };
      return;
    }
  }

  // Below: legacy CLI / Ollama path — only reachable when the operator
  // explicitly opted in via ATLAS_CHAT_ALLOW_FALLBACK.
  if (fb === "ollama") {
    yield* runOllamaFallback(input, wsFailureForCli || "ws-skipped");
    return;
  }

  const config = readOpenClawConfig();
  const strategies = parseStrategiesFromEnv();

  let lastError: unknown = null;
  let lastStderr = "";
  let cliAnnounced = false;
  const lastWsFatal: string | null = wsFailureForCli;

  for (const strategy of strategies) {
    const args = strategy.args(input);
    const env = {
      ...process.env,
      ...buildProviderEnv(),
      OPENCLAW_DIR: config.openclawDir,
      OPENCLAW_WORKSPACE: input.workspace || config.openclawWorkspace,
    };

    if (process.env.MEMORY_DEBUG === "1") {
      console.log(`[openclaw-runner] try ${strategy.label}: ${config.openclawBin} ${args.join(" ")}`);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.openclawBin, args, { env, windowsHide: true });
    } catch (err) {
      if (isMissingBinary(err)) {
        yield {
          type: "error",
          code: "OPENCLAW_NOT_FOUND",
          message: `OpenClaw CLI nao encontrado (${config.openclawBin}). Configure em Settings > OpenClaw ou instale o binario.`,
        };
        return;
      }
      lastError = err;
      continue;
    }

    if (strategy.promptOnStdin) {
      child.stdin.write(input.prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, TIMEOUT_MS);

    let buffer = "";
    let emittedAnyEvent = false;
    const pendingChunks: string[] = [];

    const drainLines = (final: boolean): RunnerEvent[] => {
      const events: RunnerEvent[] = [];
      let lines: string[];
      if (final) {
        lines = buffer.split(/\r?\n/);
        buffer = "";
      } else {
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        lines = parts;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        const evt = lineToEvent(line);
        if (evt) {
          events.push(evt);
          emittedAnyEvent = true;
        } else {
          pendingChunks.push(line);
        }
      }
      return events;
    };

    const onChunk = (chunk: string) => {
      buffer += chunk;
    };

    if (!cliAnnounced) {
      // Include the WS failure reason (if any) so the bubble badge
      // tells the operator exactly why we fell back, not just that we
      // did. E.g. "CLI · WS rejeitou: handshake timeout".
      const detail = (() => {
        const label = strategy.label;
        if (lastWsFatal) {
          return `${label} · WS: ${lastWsFatal.slice(0, 80)}`;
        }
        return label;
      })();
      yield { type: "provider", provider: "cli", detail };
      cliAnnounced = true;
    }

    let result: SpawnResult;
    try {
      const promise = spawnPromise(child, onChunk, input.signal);
      // Periodically drain partial JSON lines while child runs
      while (true) {
        const raced = await Promise.race([
          promise,
          new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 80)),
        ]);
        const events = drainLines(false);
        for (const e of events) yield e;
        if (raced !== "tick") {
          result = raced as SpawnResult;
          break;
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      if (isMissingBinary(err)) {
        yield {
          type: "error",
          code: "OPENCLAW_NOT_FOUND",
          message: `OpenClaw CLI nao encontrado (${config.openclawBin}). Configure em Settings > OpenClaw ou instale o binario.`,
        };
        return;
      }
      lastError = err;
      continue;
    }
    clearTimeout(timeout);

    // Final drain
    const finalEvents = drainLines(true);
    for (const e of finalEvents) yield e;

    if (result.exitCode !== 0 && !emittedAnyEvent) {
      // Strategy failed — try the next one. Keep stderr around so the
      // Ollama fallback can include the most informative message in
      // its diagnostic output if every strategy fails.
      lastStderr = result.stderr.slice(0, 240) || lastStderr;
      lastError = new Error(
        `openclaw ${strategy.label} exited ${result.exitCode}: ${result.stderr.slice(0, 240)}`,
      );
      continue;
    }

    // If no structured events were emitted but we collected raw text,
    // try interpreting the *whole stdout* as a single pretty-printed
    // JSON envelope — that's how `openclaw agent --json` actually
    // shapes its output. The canonical envelope nests the visible reply
    // under `result.payloads[0].text` (or `result.meta.finalAssistantVisibleText`)
    // and the usage stats under `result.meta.agentMeta.usage`.
    if (!emittedAnyEvent && pendingChunks.length > 0) {
      const text = pendingChunks.join("\n").trim();
      const envelope = parseAgentEnvelope(text);
      if (envelope.sessionId) {
        yield { type: "session", sessionId: envelope.sessionId };
      }
      const finalText = envelope.reply ?? text;
      for (const chunk of chunkText(finalText)) {
        yield { type: "token", delta: chunk };
      }
      if (envelope.usage) {
        yield {
          type: "usage",
          tokensIn: envelope.usage.tokensIn,
          tokensOut: envelope.usage.tokensOut,
          model: envelope.usage.model,
        };
      }
    }

    if (input.signal?.aborted) {
      yield { type: "error", code: "ABORTED", message: "Stream aborted by client" };
      return;
    }

    yield { type: "done" };
    return;
  }

  // All OpenClaw CLI strategies failed. Only chain into Ollama when the
  // operator opted into the full legacy fallback ("any"). With fb="cli"
  // the user only wants the CLI tier, so surface the CLI error directly.
  const reason =
    (lastError instanceof Error ? lastError.message : String(lastError ?? "unknown failure")) ||
    lastStderr ||
    "unknown failure";
  if (process.env.MEMORY_DEBUG === "1") {
    console.log(
      `[openclaw-runner] all CLI strategies failed (fallback=${fb}). ${reason}`,
    );
  }
  if (fb === "any") {
    yield* runOllamaFallback(input, reason.slice(0, 160));
    return;
  }
  yield {
    type: "error",
    code: "CLI_FAILED",
    message: `OpenClaw CLI falhou em todas as estratégias: ${reason.slice(0, 200)}`,
  };
}
