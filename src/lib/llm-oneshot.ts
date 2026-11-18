/**
 * One-shot LLM calls for background jobs (memory extraction, reflection,
 * the onboarding wizard) through the OpenClaw gateway — the same
 * subscription/credentials the bot uses, no separate API key.
 *
 * Why this exists: the old extractor called `openclaw ask|chat|complete`,
 * subcommands that no longer exist, swallowed the error and fell back to
 * a heuristic that saved "Usuário pediu: …" paraphrases. Nothing
 * resembling a fact or preference was ever extracted.
 *
 * Strategy (first that works is remembered for the process lifetime):
 *   1. `openclaw infer model run --json --prompt <text>` — a bare model
 *      call: no tools, no MCP, no bootstrap files, input not written to
 *      any chat transcript. Routed through the running gateway, which
 *      owns the OAuth credentials. (docs.openclaw.ai/cli/infer)
 *   2. `openclaw agent --message-file - --json` with a throwaway session
 *      id — a full agent turn. Heavier and leaves a transcript, which is
 *      why every prompt starts with ONESHOT_MARKER: the extractor drops
 *      any exchange carrying it, so we never learn from our own prompts.
 *
 * Guarantees: one call at a time (the gateway blocks while serving it),
 * a circuit breaker so a broken CLI doesn't burn minutes per batch, and
 * stdin for the prompt (no argv length limits).
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { parseAgentEnvelope } from "@/lib/openclaw-runner";
import { buildProviderEnv } from "@/lib/provider-keys";
import { markSelfActivity } from "@/lib/agent-activity";

export const ONESHOT_MARKER = "[atlas:memory-oneshot]";

const MAX_STDOUT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 150_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

type Strategy = "infer" | "agent" | "override";

export class OneShotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneShotUnavailableError";
  }
}

export interface OneShotOptions<T> {
  /** Short label for logs/job rows: "extract", "reflect", "wizard"… */
  purpose: string;
  timeoutMs?: number;
  /** Accept the parsed JSON only if this returns true (shape check). */
  validate?: (value: unknown) => value is T;
}

export interface OneShotResult<T> {
  data: T;
  strategy: Strategy;
  durationMs: number;
}

let queue: Promise<unknown> = Promise.resolve();
let preferred: Strategy | null = null;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
let lastError: string | null = null;

export function getOneShotStatus(): {
  preferred: Strategy | null;
  breakerOpen: boolean;
  breakerOpenUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
} {
  return {
    preferred,
    breakerOpen: Date.now() < breakerOpenUntil,
    breakerOpenUntil: breakerOpenUntil ? new Date(breakerOpenUntil).toISOString() : null,
    consecutiveFailures,
    lastError,
  };
}

export function isOneShotAvailable(): boolean {
  return Date.now() >= breakerOpenUntil;
}

function strategyArgs(strategy: Strategy, timeoutMs: number): string[] {
  const model = process.env.MEMORY_LLM_MODEL?.trim();
  if (strategy === "infer") {
    // OpenClaw 2026.11.3 (prod) has `--prompt <text>` but no
    // `--prompt-stdin`/`--prompt-file`; the prompt is appended in attempt().
    // Verified on the VPS: ~17s, transport "local", text in outputs[].text.
    const args = ["infer", "model", "run", "--json"];
    if (model) args.push("--model", model);
    return args;
  }
  if (strategy === "agent") {
    const agent = process.env.MEMORY_LLM_AGENT?.trim() || "main";
    const args = [
      "agent",
      "--agent", agent,
      "--session-id", `atlas-memory-${randomUUID()}`,
      "--message-file", "-",
      "--timeout", String(Math.max(30, Math.round(timeoutMs / 1000))),
      "--json",
    ];
    if (model) args.push("--model", model);
    return args;
  }
  // Escape hatch for unusual CLI builds: prompt still goes to stdin.
  return (process.env.MEMORY_EXTRACTION_CMD || "").trim().split(/\s+/).filter(Boolean);
}

function runCli(args: string[], input: string, timeoutMs: number): Promise<string> {
  const config = readOpenClawConfig();
  return new Promise((resolve, reject) => {
    const child = spawn(config.openclawBin, args, {
      windowsHide: true,
      env: {
        ...process.env,
        ...buildProviderEnv(),
        OPENCLAW_DIR: config.openclawDir,
        OPENCLAW_WORKSPACE: config.openclawWorkspace,
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err: Error | null, out?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) {
        child.kill("SIGKILL");
        finish(new Error("stdout exceeded limit"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`exit ${code}: ${(stderr || stdout).trim().slice(0, 600)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });
}

export function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Every string leaf of a JSON value, longest first. */
function stringLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") {
    if (value.length > 1) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out, depth + 1);
  }
  return out;
}

/**
 * Pull the model's JSON answer out of whatever the CLI printed. The
 * `infer` envelope doesn't document which field holds the text, and
 * `agent` nests it under payloads — so we try the known spots, then every
 * string leaf, and keep the first candidate that passes `validate`.
 */
export function parseModelJson<T>(stdout: string, validate?: (v: unknown) => v is T): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  let envelope: unknown = null;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    envelope = null;
  }

  if (envelope && typeof envelope === "object") {
    const env = envelope as Record<string, unknown>;
    if (env.ok === false) {
      const e = env.error as Record<string, unknown> | string | undefined;
      const msg = typeof e === "string" ? e : (e?.message as string) || JSON.stringify(e ?? {});
      throw new Error(`CLI reported failure: ${String(msg).slice(0, 400)}`);
    }
    const reply = parseAgentEnvelope(trimmed).reply;
    if (reply) candidates.push(reply);
    candidates.push(...stringLeaves(envelope).sort((a, b) => b.length - a.length));
    // The envelope itself might already be the answer (override commands).
    if (!validate || validate(envelope)) {
      if (!("capability" in env) && !("payloads" in env) && !("result" in env)) return envelope as T;
    }
  } else {
    candidates.push(trimmed);
  }

  for (const text of candidates) {
    const json = extractJsonObject(text);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!validate || validate(parsed)) return parsed as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function attempt<T>(
  strategy: Strategy,
  prompt: string,
  opts: OneShotOptions<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = strategyArgs(strategy, timeoutMs);
  if (args.length === 0) throw new Error(`no args for strategy ${strategy}`);
  if (strategy === "infer") {
    // argv, not stdin. Linux caps one argument at 128 KiB; our prompts are
    // ~10–20k chars, so this only trips on a bug upstream.
    if (Buffer.byteLength(prompt, "utf8") > 120_000) throw new Error("prompt too large for --prompt");
    args.push("--prompt", prompt);
  }
  try {
    const stdout = await runCli(args, strategy === "infer" ? "" : prompt, timeoutMs);
    const parsed = parseModelJson<T>(stdout, opts.validate);
    if (parsed === null) {
      throw new Error(`no valid JSON in output (${stdout.trim().slice(0, 300)})`);
    }
    return parsed;
  } finally {
    markSelfActivity(Date.now());
  }
}

/**
 * Run one prompt and parse a JSON object out of the reply. Serialized
 * process-wide. Throws OneShotUnavailableError while the breaker is open.
 */
export function runOneShotJson<T>(prompt: string, opts: OneShotOptions<T>): Promise<OneShotResult<T>> {
  const job = queue.then(async () => {
    if (Date.now() < breakerOpenUntil) {
      throw new OneShotUnavailableError(
        `LLM indisponível até ${new Date(breakerOpenUntil).toISOString()} (último erro: ${lastError ?? "?"})`,
      );
    }
    const fullPrompt = prompt.startsWith(ONESHOT_MARKER) ? prompt : `${ONESHOT_MARKER}\n${prompt}`;
    const order: Strategy[] = process.env.MEMORY_EXTRACTION_CMD
      ? ["override"]
      : preferred
        ? [preferred, ...(["infer", "agent"] as Strategy[]).filter((s) => s !== preferred)]
        : ["infer", "agent"];

    const errors: string[] = [];
    const started = Date.now();
    for (const strategy of order) {
      try {
        const data = await attempt(strategy, fullPrompt, opts);
        preferred = strategy;
        consecutiveFailures = 0;
        lastError = null;
        return { data, strategy, durationMs: Date.now() - started };
      } catch (err) {
        errors.push(`${strategy}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    consecutiveFailures++;
    lastError = errors.join(" | ").slice(0, 1500);
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      preferred = null;
    }
    throw new Error(`[${opts.purpose}] todas as estratégias falharam: ${lastError}`);
  });
  queue = job.catch(() => undefined);
  return job;
}
