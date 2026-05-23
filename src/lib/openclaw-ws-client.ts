/**
 * OpenClaw Gateway WebSocket client.
 *
 * The Gateway exposes a JSON-RPC-ish WebSocket on the same port the
 * Control UI uses (default 18789). It is the canonical channel for
 * real-time chat with the agent: tokens stream as the LLM generates
 * them, tool calls/results are surfaced as discrete events, and
 * cancellation is a single `chat.abort` message away — versus the CLI
 * which buffers everything and only prints once the turn is over.
 *
 * Auth: the Gateway accepts a Bearer token shared with the HTTP API
 * (`openclaw.json` -> `gateway.auth.token`). The browser/Node WebSocket
 * constructor does not let us add request headers, so the runner
 * embeds the token in the URL query string. The Gateway accepts any of
 * `token`, `access_token`, or `auth` — we send all three to maximise
 * compatibility across builds.
 *
 * Event shapes: documented as `chat.send`/`chat.history`/`chat.abort`/
 * `chat.inject` plus event broadcasts on a `chat` channel. We translate
 * whatever shape the Gateway uses to the same RunnerEvent union the
 * SSE route already knows how to forward.
 */
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { getOpenClawGatewayInfo } from "@/lib/openclaw-config";

export interface WsChatInput {
  agentId: string;
  prompt: string;
  sessionKey: string;
  sessionId?: string | null;
  signal?: AbortSignal;
}

export type WsChatEvent =
  | { type: "token"; delta: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; output: string }
  | { type: "session"; sessionId: string }
  | { type: "usage"; tokensIn: number; tokensOut: number; cost?: number; model?: string }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WsCandidate {
  url: string;
  /** Optional bearer token to attach via Authorization header. */
  token: string | null;
}

/**
 * Build the candidate WebSocket URLs to try in order. Gateways differ
 * across builds: some expose chat on `/`, others on `/ws` or `/api/ws`.
 * We also vary how the bearer token is delivered — some gateways want
 * it in the URL query string, others expect a header (which the `ws`
 * npm package supports, unlike the browser WebSocket API). Each combo
 * is tried in sequence until one accepts the handshake.
 */
function buildWsUrlCandidates(): WsCandidate[] {
  const info = getOpenClawGatewayInfo();
  const baseUrl = info.url.replace(/^http/, "ws").replace(/\/$/, "");
  const queryParams = info.token
    ? `?${new URLSearchParams({
        token: info.token,
        access_token: info.token,
        auth: info.token,
      }).toString()}`
    : "";
  const paths = process.env.ATLAS_CHAT_WS_PATH?.trim()
    ? [process.env.ATLAS_CHAT_WS_PATH.trim()]
    : ["/", "/ws", "/api/ws", "/gateway/ws", "/chat"];
  const out: WsCandidate[] = [];
  for (const p of paths) {
    const prefix = p === "/" ? "" : p;
    // First try with Authorization header (matches the HTTP API auth flow
    // most gateways expose) + no query token.
    if (info.token) {
      out.push({ url: `${baseUrl}${prefix}`, token: info.token });
    }
    // Then with token-in-query, no header (for builds that ignore headers).
    out.push({ url: `${baseUrl}${prefix}${queryParams}`, token: null });
  }
  return out;
}

/**
 * Heuristic translator: take a raw message coming off the WebSocket
 * and produce zero or more RunnerEvents. We deliberately accept a
 * handful of shapes because different OpenClaw builds vary slightly
 * in event naming (`type` vs `event`, `delta` vs `text`, etc.).
 */
function translateMessage(raw: unknown, state: { runId: string | null }): WsChatEvent[] {
  if (!isRecord(raw)) return [];
  const events: WsChatEvent[] = [];

  // RPC acknowledgement carries runId + status
  const result = raw.result;
  if (isRecord(result)) {
    if (typeof result.runId === "string") {
      state.runId = result.runId;
    }
    if (typeof result.sessionId === "string") {
      events.push({ type: "session", sessionId: result.sessionId });
    }
  }

  // Error envelope (JSON-RPC style)
  if (isRecord(raw.error)) {
    const err = raw.error as { message?: unknown; code?: unknown };
    events.push({
      type: "error",
      message: typeof err.message === "string" ? err.message : "WebSocket error",
      code: typeof err.code === "string" ? err.code : undefined,
    });
    return events;
  }

  const topType = typeof raw.type === "string" ? raw.type : undefined;
  const topEvent = typeof raw.event === "string" ? raw.event : undefined;
  const channel = typeof raw.channel === "string" ? raw.channel : undefined;

  // The Control UI receives events on a "chat" channel. Drop anything
  // that is clearly unrelated (channel-membership, ping, etc.).
  if (channel && channel !== "chat" && channel !== "agent" && channel !== "session") {
    return events;
  }

  const subtype = (() => {
    const candidates = [raw.subtype, raw.kind, raw.payloadType, raw.eventType, raw.name];
    for (const c of candidates) {
      if (typeof c === "string") return c.toLowerCase();
    }
    return undefined;
  })();

  const payload =
    (isRecord(raw.payload) && (raw.payload as Record<string, unknown>)) ||
    (isRecord(raw.data) && (raw.data as Record<string, unknown>)) ||
    raw;

  const grabString = (key: string): string | null => {
    const v = (payload as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  };

  const looksLikeChatEvent = topType === "chat" || topEvent === "chat" || channel === "chat";

  // Token / delta
  const delta =
    grabString("delta") ??
    grabString("text") ??
    grabString("content") ??
    grabString("chunk");
  if (delta && (looksLikeChatEvent || subtype === "delta" || subtype === "token" || subtype === "text")) {
    events.push({ type: "token", delta });
  }

  // Tool use
  if (subtype === "tool_use" || subtype === "tool_call" || topType === "tool_use") {
    events.push({
      type: "tool_use",
      id: grabString("id") ?? undefined,
      name: grabString("name") ?? "tool",
      input:
        (payload as Record<string, unknown>).input ??
        (payload as Record<string, unknown>).arguments ??
        null,
    });
  }

  // Tool result
  if (subtype === "tool_result" || topType === "tool_result") {
    events.push({
      type: "tool_result",
      id: grabString("id") ?? undefined,
      output:
        grabString("output") ??
        grabString("result") ??
        grabString("content") ??
        "",
    });
  }

  // Usage / completion stats
  if (subtype === "usage" || subtype === "tokens" || topType === "usage") {
    const u = payload as Record<string, unknown>;
    events.push({
      type: "usage",
      tokensIn: Number(u.input ?? u.tokensIn ?? u.input_tokens ?? 0),
      tokensOut: Number(u.output ?? u.tokensOut ?? u.output_tokens ?? 0),
      model: typeof u.model === "string" ? u.model : undefined,
    });
  }

  // Done signal (multiple possible spellings)
  if (
    subtype === "done" ||
    subtype === "end" ||
    subtype === "finish" ||
    subtype === "completed" ||
    topType === "done" ||
    typeof raw.done === "boolean" && raw.done
  ) {
    events.push({ type: "done" });
  }

  return events;
}

/**
 * Runs a single chat turn over the Gateway WebSocket and yields runner
 * events as they arrive. The generator returns once a "done" event is
 * observed, an error is emitted, or the input AbortSignal fires.
 */
function openWs(candidate: WsCandidate): WebSocket {
  const headers: Record<string, string> = {};
  if (candidate.token) {
    headers.Authorization = `Bearer ${candidate.token}`;
  }
  return new WebSocket(candidate.url, { headers });
}

function describe(candidate: WsCandidate): string {
  return `${candidate.url} (${candidate.token ? "header bearer" : "query token"})`;
}

export async function* runOpenClawWsChat(input: WsChatInput): AsyncGenerator<WsChatEvent> {
  const candidates = buildWsUrlCandidates();
  const debug = process.env.MEMORY_DEBUG === "1";

  // Probe each candidate until one accepts the upgrade. Each attempt
  // gets up to 1.5s; we collect *all* failure reasons so the SSE
  // bubble can surface a useful diagnostic (eg. "5 paths · last:
  // closed 4401 invalid token").
  let winning: WsCandidate | null = null;
  const probeErrors: string[] = [];
  for (const candidate of candidates) {
    const probeOk = await new Promise<boolean>((resolve) => {
      let probe: WebSocket;
      try {
        probe = openWs(candidate);
      } catch (err) {
        probeErrors.push(`${describe(candidate)}: ${(err as Error).message}`);
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        try {
          probe.close();
        } catch {}
        probeErrors.push(`${describe(candidate)}: handshake timeout 1.5s`);
        resolve(false);
      }, 1500);
      probe.once("open", () => {
        clearTimeout(timer);
        try {
          probe.close(1000, "probe ok");
        } catch {}
        resolve(true);
      });
      probe.once("error", (err: Error) => {
        clearTimeout(timer);
        probeErrors.push(`${describe(candidate)}: ${err.message}`);
        resolve(false);
      });
      probe.once("close", (code: number, reason: Buffer) => {
        clearTimeout(timer);
        if (code !== 1000) {
          probeErrors.push(
            `${describe(candidate)}: closed ${code} ${reason.toString() || ""}`.trim(),
          );
          resolve(false);
        }
      });
    });
    if (probeOk) {
      winning = candidate;
      if (debug) console.log("[ws] probe accepted:", describe(candidate));
      break;
    }
    if (debug) console.log("[ws] probe rejected:", probeErrors[probeErrors.length - 1]);
  }

  if (!winning) {
    yield {
      type: "error",
      code: "WS_HANDSHAKE_TIMEOUT",
      message: `Gateway nao aceitou nenhum dos ${candidates.length} probes. ${probeErrors.slice(-3).join(" · ")}`,
    };
    return;
  }

  let ws: WebSocket;
  try {
    ws = openWs(winning);
  } catch (err) {
    yield {
      type: "error",
      code: "WS_CONNECT_FAIL",
      message: `Nao foi possivel conectar ao gateway: ${(err as Error).message}`,
    };
    return;
  }

  const queue: WsChatEvent[] = [];
  let resolveNext: ((value: void) => void) | null = null;
  let closed = false;
  const state: { runId: string | null } = { runId: null };

  const wake = () => {
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  ws.on("open", () => {
    if (debug) console.log("[ws] open", winning.url);
    const req: RpcRequest = {
      id: randomUUID(),
      method: "chat.send",
      params: {
        sessionKey: input.sessionKey,
        agent: input.agentId,
        agentId: input.agentId,
        message: input.prompt,
        idempotencyKey: randomUUID(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    };
    try {
      ws.send(JSON.stringify(req));
    } catch (err) {
      queue.push({
        type: "error",
        code: "WS_SEND_FAIL",
        message: `Falha ao enviar chat.send: ${(err as Error).message}`,
      });
      wake();
    }
  });

  ws.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    if (!text) return;
    if (debug) console.log("[ws] msg", text.slice(0, 200));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const events = translateMessage(parsed, state);
    if (events.length > 0) {
      queue.push(...events);
      wake();
    }
  });

  ws.on("error", (err: Error) => {
    if (debug) console.log("[ws] error", err.message);
    queue.push({
      type: "error",
      code: "WS_ERROR",
      message: `Erro na conexao WebSocket: ${err.message}`,
    });
    wake();
  });

  ws.on("close", (code: number, reason: Buffer) => {
    if (debug) console.log("[ws] close", code, reason.toString());
    closed = true;
    // If we closed without ever getting a "done", surface a soft error
    // so the runner can fall back to CLI.
    if (code !== 1000) {
      queue.push({
        type: "error",
        code: `WS_CLOSE_${code}`,
        message: `Gateway fechou a conexao (${code} ${reason.toString() || ""})`.trim(),
      });
    }
    wake();
  });

  const handshakeDeadline = Date.now() + DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const overallDeadline = Date.now() + DEFAULT_OVERALL_TIMEOUT_MS;

  const abortHandler = () => {
    if (state.runId) {
      try {
        ws.send(
          JSON.stringify({
            method: "chat.abort",
            params: { sessionKey: input.sessionKey, runId: state.runId },
          }),
        );
      } catch {}
    }
    try {
      ws.close(1000, "client abort");
    } catch {}
    queue.push({ type: "error", code: "ABORTED", message: "Stream aborted by client" });
    wake();
  };
  input.signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    // Wait for first byte until handshake deadline; if WS never opens
    // (refused, wrong path), bail early so the runner falls back.
    while (queue.length === 0 && ws.readyState !== ws.OPEN) {
      if (Date.now() > handshakeDeadline) {
        yield {
          type: "error",
          code: "WS_HANDSHAKE_TIMEOUT",
          message: "Gateway nao aceitou a conexao WebSocket em 5s",
        };
        try {
          ws.close();
        } catch {}
        return;
      }
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
        setTimeout(resolve, 50);
      });
    }

    while (true) {
      while (queue.length > 0) {
        const evt = queue.shift()!;
        yield evt;
        if (evt.type === "done" || evt.type === "error") {
          try {
            ws.close(1000, "done");
          } catch {}
          return;
        }
      }
      if (closed) return;
      if (Date.now() > overallDeadline) {
        yield {
          type: "error",
          code: "WS_TIMEOUT",
          message: "Timeout de 2min aguardando resposta do gateway",
        };
        try {
          ws.close();
        } catch {}
        return;
      }
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
        setTimeout(resolve, 500);
      });
    }
  } finally {
    input.signal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * Convenience flag the runner uses to skip the WebSocket path when the
 * operator explicitly forces another provider via env.
 */
export function isWsEnabled(): boolean {
  if (process.env.ATLAS_CHAT_WS === "0" || process.env.ATLAS_CHAT_WS === "off") {
    return false;
  }
  return true;
}
