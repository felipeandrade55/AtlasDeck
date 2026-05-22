/**
 * OpenClaw chat runner.
 *
 * Spawns the OpenClaw CLI as a subprocess and adapts its output into a
 * uniform event stream the chat layer (API + UI) consumes regardless of
 * whether OpenClaw is producing JSON events, JSONL or plain text.
 *
 * The CLI shape varies (different builds expose `chat`, `ask`, or
 * `complete`), so the runner tries a sequence of argument shapes and
 * falls back gracefully. Streaming is best-effort: if the CLI does not
 * support it, the runner still emits incremental token events by
 * chunking the buffered output, so the UI behaves consistently.
 *
 * If `openclaw` is not installed (typical in local dev), the runner
 * surfaces a friendly error event instead of crashing the request.
 */
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { readOpenClawConfig } from "@/lib/openclaw-config";

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

const DEFAULT_STRATEGIES: ArgStrategy[] = [
  {
    label: "chat-stream-stdin",
    promptOnStdin: true,
    args: ({ agentId, sessionId }) => {
      const a = ["chat", "--agent", agentId, "--json", "--stream"];
      if (sessionId) a.push("--session", sessionId);
      return a;
    },
  },
  {
    label: "chat-stream-arg",
    args: ({ agentId, sessionId, prompt }) => {
      const a = ["chat", "--agent", agentId, "--json", "--stream"];
      if (sessionId) a.push("--session", sessionId);
      a.push(prompt);
      return a;
    },
  },
  {
    label: "chat-json",
    args: ({ agentId, sessionId, prompt }) => {
      const a = ["chat", "--agent", agentId, "--json"];
      if (sessionId) a.push("--session", sessionId);
      a.push(prompt);
      return a;
    },
  },
  {
    label: "ask",
    args: ({ prompt }) => ["ask", "--json", "--prompt", prompt],
  },
  {
    label: "complete",
    args: ({ prompt }) => ["complete", "--json", prompt],
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

export async function* runOpenClawChat(input: RunnerInput): AsyncGenerator<RunnerEvent> {
  const config = readOpenClawConfig();
  const strategies = parseStrategiesFromEnv();

  let lastError: unknown = null;

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
      // Strategy failed — try the next one
      lastError = new Error(
        `openclaw ${strategy.label} exited ${result.exitCode}: ${result.stderr.slice(0, 240)}`,
      );
      continue;
    }

    // If no structured events were emitted but we collected raw text, chunk it
    if (!emittedAnyEvent && pendingChunks.length > 0) {
      const text = pendingChunks.join("\n");
      for (const chunk of chunkText(text)) {
        yield { type: "token", delta: chunk };
      }
    }

    if (input.signal?.aborted) {
      yield { type: "error", code: "ABORTED", message: "Stream aborted by client" };
      return;
    }

    yield { type: "done" };
    return;
  }

  // All strategies failed
  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown failure");
  yield { type: "error", message: `OpenClaw nao respondeu em nenhuma estrategia: ${msg}` };
}
