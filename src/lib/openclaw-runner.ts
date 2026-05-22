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

export interface RunnerInput {
  agentId: string;
  prompt: string;
  threadId: string;
  sessionId?: string | null;
  workspace?: string | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
}

export type RunnerEvent =
  | { type: "token"; delta: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; output: string }
  | { type: "session"; sessionId: string }
  | { type: "usage"; tokensIn: number; tokensOut: number; cost?: number; model?: string }
  | { type: "done" }
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

export async function* runOpenClawChat(input: RunnerInput): AsyncGenerator<RunnerEvent> {
  // Allow forcing Ollama via env (useful while the OpenClaw CLI surface is
  // still being mapped — defaults to trying OpenClaw first).
  if (process.env.ATLAS_CHAT_PROVIDER === "ollama") {
    yield* runOllamaFallback(input, "ATLAS_CHAT_PROVIDER=ollama");
    return;
  }

  const config = readOpenClawConfig();
  const strategies = parseStrategiesFromEnv();

  let lastError: unknown = null;
  let lastStderr = "";

  for (const strategy of strategies) {
    const args = strategy.args(input);
    const env = {
      ...process.env,
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
    // JSON envelope first — that's how `openclaw agent --json` actually
    // shapes its output. Common fields: response, message, content, text.
    if (!emittedAnyEvent && pendingChunks.length > 0) {
      const text = pendingChunks.join("\n").trim();
      let extracted: string | null = null;
      let usage: { tokensIn: number; tokensOut: number; model?: string } | null = null;
      if (text.startsWith("{") || text.startsWith("[")) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const candidate =
            (typeof parsed.response === "string" && parsed.response) ||
            (typeof parsed.message === "string" && parsed.message) ||
            (typeof parsed.content === "string" && parsed.content) ||
            (typeof parsed.text === "string" && parsed.text) ||
            (typeof parsed.output === "string" && parsed.output) ||
            (typeof parsed.reply === "string" && parsed.reply) ||
            null;
          if (candidate) extracted = candidate;
          const tokensIn = Number(parsed.tokensIn ?? parsed.input_tokens ?? parsed.promptTokens ?? 0);
          const tokensOut = Number(parsed.tokensOut ?? parsed.output_tokens ?? parsed.completionTokens ?? 0);
          if (tokensIn || tokensOut) {
            usage = {
              tokensIn,
              tokensOut,
              model: typeof parsed.model === "string" ? parsed.model : undefined,
            };
          }
        } catch {
          // not single-JSON; treat as raw text below
        }
      }

      const finalText = extracted ?? text;
      for (const chunk of chunkText(finalText)) {
        yield { type: "token", delta: chunk };
      }
      if (usage) {
        yield {
          type: "usage",
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          model: usage.model,
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

  // All OpenClaw CLI strategies failed — fall back to Ollama. Surface
  // a single status token so the user can see we switched providers.
  const reason =
    (lastError instanceof Error ? lastError.message : String(lastError ?? "unknown failure")) ||
    lastStderr ||
    "unknown failure";
  if (process.env.MEMORY_DEBUG === "1") {
    console.log(`[openclaw-runner] all CLI strategies failed; falling back to Ollama. ${reason}`);
  }
  yield* runOllamaFallback(input, reason.slice(0, 160));
}
