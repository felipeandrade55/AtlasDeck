/**
 * OpenClaw Gateway WebSocket client.
 *
 * Protocol confirmed from the docs shipped with `openclaw@2026.5.20`
 * (npm) — see `docs/gateway/protocol.md`. The handshake is:
 *
 *   1. Client → Gateway: WebSocket Upgrade with Authorization Bearer header
 *   2. Gateway → Client: { type: "event", event: "connect.challenge",
 *                          payload: { nonce, ts } }
 *   3. Client → Gateway: { type: "req", id, method: "connect", params: {...} }
 *   4. Gateway → Client: { type: "res", id, ok: true, payload: { type: "hello-ok",
 *                          server, features, snapshot, policy, auth, ... } }
 *   5. Client → Gateway: { type: "req", id, method: "chat.send", params: {
 *                          sessionKey, message, idempotencyKey, sessionId? } }
 *   6. Gateway → Client: stream of { type: "event", event: "chat.event",
 *                          payload: { runId, sessionKey, seq,
 *                                     state: "delta"|"final"|"aborted"|"error",
 *                                     deltaText, usage } }
 *
 * Auth path on loopback (mission-control → OpenClaw on same host) uses
 * `client.mode: "backend"` + `client.id: "gateway-client"` to skip
 * device pairing — see protocol.md "Trusted same-process backend
 * clients" section.
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
  | { type: "timing"; phase: "handshake" | "hello-ok" | "chat-send" | "first-delta" | "final"; ms: number }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `JSON.stringify` with a small fence against circular refs so the
 * diagnostic dump can't crash the stream when the gateway happens to
 * send a self-referential structure.
 */
function safeStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v as object)) return "[Circular]";
          seen.add(v as object);
        }
        return v;
      },
      indent,
    );
  } catch {
    return String(value);
  }
}

interface WsCandidate {
  url: string;
  token: string | null;
  origin: string | null;
}

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
  const origin = process.env.ATLAS_CHAT_WS_ORIGIN?.trim() || null;

  const out: WsCandidate[] = [];
  for (const p of paths) {
    const prefix = p === "/" ? "" : p;
    if (info.token) {
      out.push({ url: `${baseUrl}${prefix}`, token: info.token, origin });
    }
    out.push({ url: `${baseUrl}${prefix}${queryParams}`, token: null, origin });
  }
  return out;
}

interface RunnerState {
  runId: string | null;
  helloOk: boolean;
  /**
   * Tracks whether we already emitted at least one `delta` token to the
   * caller. When the gateway runs in buffered mode (no `blockStreamingDefault`
   * server-side), the entire reply arrives in a single `final` frame with
   * the text in `deltaText` / `result.payloads[0].text` / etc. and zero
   * preceding `delta` frames. We use this flag in the `final` handler to
   * decide whether we still need to emit the visible text as a token so
   * the UI bubble doesn't render blank.
   */
  tokensEmitted: boolean;
  /**
   * Rolling log of every WS frame received in this session, truncated to
   * 600 chars each and capped at 40 entries. When `final` arrives with
   * no text we dump the full transcript so the operator can see exactly
   * what the gateway sent and we can patch the parser if a new event
   * shape shows up. Cheap to maintain (one Array.push per frame) and
   * invaluable for diagnosing a gateway that silently swallows replies.
   */
  frameLog: string[];
}

const FRAME_LOG_MAX = 40;
const FRAME_LOG_TRUNC = 600;

/**
 * Field names where OpenClaw builds have historically placed the visible
 * assistant reply inside a `chat.event` payload. Order matters — the
 * left-most known field wins. Listed in the rough order they were
 * introduced across gateway versions so the most current name takes
 * priority while older builds still get matched.
 */
const KNOWN_TEXT_FIELDS = [
  "deltaText",
  "text",
  "responseText",
  "message",
  "content",
  "reply",
  "output",
  "answer",
  "assistantText",
  "value",
  "data",
] as const;

/**
 * Last-resort recursive scan: walks the payload graph collecting every
 * string value and returns the longest one above `minLength`. Stops at
 * `maxDepth` and skips obviously diagnostic keys (ids, types, codes,
 * timestamps, model names) so we don't accidentally pick up "chat.event"
 * or a runId as the assistant reply.
 *
 * This is the safety net for OpenClaw builds whose `final` frame puts
 * the reply under a key we don't yet know about — better to surface
 * *something* (we can always refine the parser later) than to leave the
 * user staring at an empty bubble.
 */
const TEXT_SKIP_KEYS = new Set([
  "type",
  "event",
  "id",
  "runId",
  "sessionId",
  "sessionKey",
  "connId",
  "code",
  "kind",
  "state",
  "phase",
  "name",
  "model",
  "provider",
  "mode",
  "lang",
  "locale",
  "ts",
  "createdAt",
  "updatedAt",
  "version",
  "platform",
  "userAgent",
]);

function findLongestStringDeep(
  value: unknown,
  minLength: number,
  maxDepth: number,
): string {
  let best = "";
  const visit = (node: unknown, depth: number) => {
    if (depth > maxDepth) return;
    if (typeof node === "string") {
      if (node.length >= minLength && node.length > best.length) best = node;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (TEXT_SKIP_KEYS.has(key)) continue;
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return best;
}

/**
 * Pulls the visible assistant reply out of a `chat.event` payload regardless
 * of where the gateway placed it. Different OpenClaw builds put the text in
 * different fields: streaming builds use `deltaText`; buffered builds put
 * the whole answer under `text`, `payloads[0].text`, or nest the full CLI
 * envelope under `result.payloads[0].text` /
 * `result.meta.finalAssistantVisibleText`. We accept any of them, plus a
 * recursive longest-string fallback for builds with a not-yet-mapped
 * field name.
 */
function extractPayloadText(payload: Record<string, unknown>): string {
  // Pass 1 — known top-level fields, in priority order.
  for (const field of KNOWN_TEXT_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  // Pass 2 — known nested locations (payloads[0].text, result.*).
  const payloads = Array.isArray(payload.payloads)
    ? (payload.payloads as Array<Record<string, unknown>>)
    : null;
  if (payloads && payloads[0]) {
    for (const field of KNOWN_TEXT_FIELDS) {
      const value = payloads[0][field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  const result = isRecord(payload.result)
    ? (payload.result as Record<string, unknown>)
    : null;
  if (result) {
    const resultPayloads = Array.isArray(result.payloads)
      ? (result.payloads as Array<Record<string, unknown>>)
      : null;
    if (resultPayloads && resultPayloads[0]) {
      for (const field of KNOWN_TEXT_FIELDS) {
        const value = resultPayloads[0][field];
        if (typeof value === "string" && value.trim().length > 0) {
          return value;
        }
      }
    }
    const meta = isRecord(result.meta)
      ? (result.meta as Record<string, unknown>)
      : null;
    if (meta) {
      if (
        typeof meta.finalAssistantVisibleText === "string" &&
        meta.finalAssistantVisibleText.trim().length > 0
      ) {
        return meta.finalAssistantVisibleText;
      }
      if (
        typeof meta.finalAssistantRawText === "string" &&
        meta.finalAssistantRawText.trim().length > 0
      ) {
        return meta.finalAssistantRawText;
      }
    }
  }
  // Pass 3 — last resort: longest string anywhere in the payload. Better
  // to surface the wrong-looking blob than leave the user staring at an
  // empty bubble; the operator can paste the diagnostic log and we'll
  // learn the new field name from it.
  return findLongestStringDeep(payload, 8, 6);
}

function translateMessage(raw: unknown, state: RunnerState): WsChatEvent[] {
  if (!isRecord(raw)) return [];
  const events: WsChatEvent[] = [];
  const frameType = typeof raw.type === "string" ? raw.type : undefined;

  // Server response: hello-ok or chat.send ack
  if (frameType === "res") {
    if (raw.ok === false) {
      const err = isRecord(raw.error) ? (raw.error as Record<string, unknown>) : null;
      const msg = err && typeof err.message === "string"
        ? err.message
        : "Gateway returned an error";
      const code = err && typeof err.code === "string" ? err.code : undefined;
      events.push({ type: "error", message: msg, code });
      return events;
    }
    const payload = isRecord(raw.payload) ? (raw.payload as Record<string, unknown>) : null;
    if (payload?.type === "hello-ok") {
      state.helloOk = true;
      const server = isRecord(payload.server) ? (payload.server as Record<string, unknown>) : null;
      if (server && typeof server.connId === "string") {
        events.push({ type: "session", sessionId: server.connId });
      }
    }
    if (payload && typeof payload.runId === "string") {
      state.runId = payload.runId;
    }
    return events;
  }

  // Server event: chat streaming. Rather than maintaining a brittle
  // allow-list of event names (which keeps drifting between OpenClaw
  // versions), we deny-list the obvious meta-events and try to extract
  // text from anything else. Unknown payload shapes go through the
  // recursive longest-string fallback inside `extractPayloadText`, so
  // even brand-new event names produce a usable bubble.
  if (frameType === "event") {
    const eventName = typeof raw.event === "string" ? raw.event : "";
    const payload = isRecord(raw.payload) ? (raw.payload as Record<string, unknown>) : {};

    // Meta events that carry no assistant text — skip extraction.
    const META_EVENTS = new Set([
      "connect.challenge",
      "ping",
      "pong",
      "ack",
      "heartbeat",
      "subscription.ack",
      "session.update",
      "session.expired",
    ]);
    const isMetaEvent = META_EVENTS.has(eventName);
    const isChatEvent = !isMetaEvent;

    if (isChatEvent) {
      if (typeof payload.runId === "string") state.runId = payload.runId;
      const eventState = typeof payload.state === "string" ? payload.state : undefined;

      // Try to extract text from any chat-shaped event, regardless of
      // declared state. Some gateway builds emit deltas as plain
      // `chat.delta` events with the text in `text`/`content`/etc. and
      // no `state` field at all — we capture them the same way.
      if (eventState !== "final" && eventState !== "aborted" && eventState !== "error") {
        const text = extractPayloadText(payload);
        if (text) {
          events.push({ type: "token", delta: text });
          state.tokensEmitted = true;
        }
      }

      switch (eventState) {
        case "final": {
          // Buffered mode: when no `delta` frames preceded this `final`,
          // the reply may still be inside the final payload. Try every
          // known field plus the recursive longest-string fallback.
          if (!state.tokensEmitted) {
            const finalText = extractPayloadText(payload);
            if (finalText) {
              events.push({ type: "token", delta: finalText });
              state.tokensEmitted = true;
            } else {
              // Gateway closed the stream without ever sending the
              // reply text. We surface the full frame trace inside the
              // chat bubble itself — the user can copy/paste it back
              // and we patch the parser if a new event shape appeared.
              // Also written to the server log so `pm2 logs` shows it
              // without `MEMORY_DEBUG=1`. We do NOT fall back to CLI
              // here because CLI defeats the real-time UX; the user
              // would rather see a diagnostic than wait 30s for a
              // CLI round-trip.
              const trace = state.frameLog
                .map((line, idx) => `[${idx + 1}] ${line}`)
                .join("\n");
              console.warn(
                `[ws] state=final without any text — gateway swallowed the reply.\n` +
                  `Full session trace:\n${trace}`,
              );
              const inlineTrace = trace.slice(0, 4000);
              events.push({
                type: "token",
                delta:
                  `⚠ **Gateway respondeu, mas não entregou texto.**\n\n` +
                  `Isso normalmente indica um dos seguintes:\n` +
                  `  1. O agente roteou a resposta real para outro canal (Telegram, etc.) — confira ` +
                  `\`~/.openclaw/workspace/AGENTS.md\`/\`TOOLS.md\` e remova rotas condicionais por \`sessionKey\`.\n` +
                  `  2. \`blockStreamingDefault\` está OFF no \`~/.openclaw/openclaw.json\` — adicione ` +
                  `os campos sugeridos no banner amarelo e \`systemctl --user restart openclaw-gateway\`.\n` +
                  `  3. Bug do gateway na versão atual — me cole o trace abaixo e mapeio o campo.\n\n` +
                  `**Trace dos frames recebidos via WS nesta sessão:**\n` +
                  "```json\n" +
                  inlineTrace +
                  "\n```",
              });
              state.tokensEmitted = true;
            }
          }
          const usage = isRecord(payload.usage) ? (payload.usage as Record<string, unknown>) : null;
          if (usage) {
            events.push({
              type: "usage",
              tokensIn: Number(usage.input ?? usage.tokensIn ?? 0),
              tokensOut: Number(usage.output ?? usage.tokensOut ?? 0),
              model: typeof usage.model === "string" ? usage.model : undefined,
            });
          }
          events.push({ type: "done" });
          break;
        }
        case "aborted":
          events.push({ type: "error", code: "ABORTED", message: "Aborted by server" });
          break;
        case "error": {
          const errorMsg =
            typeof payload.errorMessage === "string"
              ? payload.errorMessage
              : typeof payload.error === "string"
              ? payload.error
              : "Chat error";
          events.push({ type: "error", message: errorMsg });
          break;
        }
        default:
          break;
      }
    }
  }

  return events;
}

function openWs(candidate: WsCandidate): WebSocket {
  const headers: Record<string, string> = {};
  if (candidate.token) {
    headers.Authorization = `Bearer ${candidate.token}`;
  }
  if (candidate.origin) {
    headers.Origin = candidate.origin;
  }
  return new WebSocket(candidate.url, { headers });
}

function describe(candidate: WsCandidate): string {
  const auth = candidate.token ? "header bearer" : "query token";
  const origin = candidate.origin ? ` origin=${candidate.origin}` : "";
  return `${candidate.url} (${auth}${origin})`;
}

function buildConnectRequest(token: string | null): Record<string, unknown> {
  return {
    type: "req",
    id: randomUUID(),
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: token ? { token } : {},
      locale: "pt-BR",
      userAgent: "atlasdeck-mission-control/1.0",
    },
  };
}

function buildChatSendRequest(input: WsChatInput): Record<string, unknown> {
  // `thinking` and `fastMode` are optional. The previous experiment
  // (always sending `thinking: "off"` + `fastMode: true`) actually
  // *worsened* latency on this OpenClaw build:
  //   - `fastMode: true` maps to OpenAI `service_tier: priority`,
  //     which routes through different (often slower-when-congested)
  //     capacity tier;
  //   - `thinking: "off"` rendered the assistant unable to reason
  //     properly ("Respondi no chat" replies).
  // Now we only forward each field when the operator opts in via env,
  // matching the gateway's own defaults (agent-config driven).
  //   ATLAS_CHAT_THINKING=off|minimal|low|medium|high|max
  //   ATLAS_CHAT_FAST_MODE=true|false
  //
  // IMPORTANT — gateway has a strict schema for `chat.send` params.
  // Attempting to send `stream`/`streaming`/`blockStreaming*` etc.
  // produces an "invalid chat.send params: at root: unexpected
  // property 'X'" rejection that closes the stream in ~300ms. The
  // only accepted shape (verified against gateway 2026.5.x) is:
  // `sessionKey`, `message`, `idempotencyKey`, `sessionId?`,
  // `thinking?`, `fastMode?`. Streaming is exclusively controlled
  // server-side via `~/.openclaw/openclaw.json` agents.defaults.
  const params: Record<string, unknown> = {
    sessionKey: input.sessionKey,
    message: input.prompt,
    idempotencyKey: randomUUID(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  const thinking = process.env.ATLAS_CHAT_THINKING?.trim();
  if (thinking) params.thinking = thinking;
  const fastMode = process.env.ATLAS_CHAT_FAST_MODE?.trim();
  if (fastMode === "true") params.fastMode = true;
  if (fastMode === "false") params.fastMode = false;
  return {
    type: "req",
    id: randomUUID(),
    method: "chat.send",
    params,
  };
}

export async function* runOpenClawWsChat(input: WsChatInput): AsyncGenerator<WsChatEvent> {
  const candidates = buildWsUrlCandidates();
  const debug = process.env.MEMORY_DEBUG === "1";

  // Probe each candidate; the first whose WS upgrade returns 101 wins.
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
      message: `Falha ao conectar: ${(err as Error).message}`,
    };
    return;
  }

  const queue: WsChatEvent[] = [];
  let resolveNext: ((value: void) => void) | null = null;
  let closed = false;
  let chatSendDispatched = false;
  const state: RunnerState = {
    runId: null,
    helloOk: false,
    tokensEmitted: false,
    frameLog: [],
  };

  // Timing instrumentation — each phase records its delta from t0.
  // The chat page surfaces these in the bubble badge so it's obvious
  // whether the gateway is streaming token-by-token or batching the
  // whole reply.
  const t0 = Date.now();
  let openedAt = 0;
  let helloOkAt = 0;
  let chatSentAt = 0;
  let firstDeltaAt = 0;

  type TimingPhase = "handshake" | "hello-ok" | "chat-send" | "first-delta" | "final";
  const emitTiming = (phase: TimingPhase, at: number) => {
    queue.push({ type: "timing", phase, ms: at - t0 });
  };

  const wake = () => {
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  const send = (frame: Record<string, unknown>) => {
    try {
      const json = JSON.stringify(frame);
      if (debug) console.log("[ws] send", json.slice(0, 200));
      ws.send(json);
    } catch (err) {
      queue.push({
        type: "error",
        code: "WS_SEND_FAIL",
        message: `Falha enviando frame: ${(err as Error).message}`,
      });
      wake();
    }
  };

  const sendChatIfReady = () => {
    if (!state.helloOk || chatSendDispatched) return;
    chatSendDispatched = true;
    chatSentAt = Date.now();
    emitTiming("chat-send", chatSentAt);
    send(buildChatSendRequest(input));
  };

  ws.on("open", () => {
    openedAt = Date.now();
    emitTiming("handshake", openedAt);
    if (debug) console.log("[ws] open", winning.url);
    // Do nothing here — wait for connect.challenge from the server. Per
    // the protocol, the first frame the server sends is the challenge,
    // and the client's first frame must be the `connect` request.
  });

  ws.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    if (!text) return;
    if (debug) console.log("[ws] msg", text.slice(0, 240));

    // Always record the frame in the rolling log so we can dump the
    // whole session if the gateway closes without ever sending text.
    // The translate path may drop unknown shapes silently — this log
    // is the ground truth of what arrived on the socket.
    if (state.frameLog.length >= FRAME_LOG_MAX) state.frameLog.shift();
    state.frameLog.push(text.length > FRAME_LOG_TRUNC ? `${text.slice(0, FRAME_LOG_TRUNC)}…` : text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    // Handshake step 2: server sent connect.challenge → reply with `connect` req
    if (
      isRecord(parsed) &&
      parsed.type === "event" &&
      parsed.event === "connect.challenge"
    ) {
      if (debug) console.log("[ws] received connect.challenge, sending connect req");
      send(buildConnectRequest(winning.token));
      return;
    }

    const events = translateMessage(parsed, state);
    if (events.length > 0) {
      const sawHelloOk = events.some((e) => e.type === "session");
      if (sawHelloOk && helloOkAt === 0) {
        helloOkAt = Date.now();
        emitTiming("hello-ok", helloOkAt);
        sendChatIfReady();
      }
      const hasToken = events.some((e) => e.type === "token");
      if (hasToken && firstDeltaAt === 0) {
        firstDeltaAt = Date.now();
        emitTiming("first-delta", firstDeltaAt);
      }
      const isDone = events.some((e) => e.type === "done");
      if (isDone) {
        emitTiming("final", Date.now());
      }
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
    if (code !== 1000) {
      queue.push({
        type: "error",
        code: `WS_CLOSE_${code}`,
        message: `Gateway fechou a conexao (${code} ${reason.toString() || ""})`.trim(),
      });
    }
    wake();
  });

  const overallDeadline = Date.now() + DEFAULT_OVERALL_TIMEOUT_MS;
  const helloDeadline = Date.now() + DEFAULT_HANDSHAKE_TIMEOUT_MS;

  const abortHandler = () => {
    if (state.runId) {
      try {
        send({
          type: "req",
          id: randomUUID(),
          method: "chat.abort",
          params: { sessionKey: input.sessionKey, runId: state.runId },
        });
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
      if (!state.helloOk && Date.now() > helloDeadline) {
        yield {
          type: "error",
          code: "WS_HELLO_TIMEOUT",
          message: `Gateway nao retornou hello-ok em ${DEFAULT_HANDSHAKE_TIMEOUT_MS / 1000}s. Verifique o token.`,
        };
        try {
          ws.close();
        } catch {}
        return;
      }
      if (Date.now() > overallDeadline) {
        yield {
          type: "error",
          code: "WS_TIMEOUT",
          message: "Timeout de 2min aguardando resposta",
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

export function isWsEnabled(): boolean {
  if (process.env.ATLAS_CHAT_WS === "0" || process.env.ATLAS_CHAT_WS === "off") {
    return false;
  }
  return true;
}
