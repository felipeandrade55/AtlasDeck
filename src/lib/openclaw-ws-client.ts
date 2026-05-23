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
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  // Server event: chat streaming
  if (frameType === "event") {
    const eventName = typeof raw.event === "string" ? raw.event : undefined;
    const payload = isRecord(raw.payload) ? (raw.payload as Record<string, unknown>) : {};

    if (eventName === "chat.event" || eventName === "chat") {
      if (typeof payload.runId === "string") state.runId = payload.runId;
      const eventState = typeof payload.state === "string" ? payload.state : undefined;
      switch (eventState) {
        case "delta": {
          const deltaText = typeof payload.deltaText === "string" ? payload.deltaText : "";
          if (deltaText) events.push({ type: "token", delta: deltaText });
          break;
        }
        case "final": {
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
            typeof payload.errorMessage === "string" ? payload.errorMessage : "Chat error";
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
  return {
    type: "req",
    id: randomUUID(),
    method: "chat.send",
    params: {
      sessionKey: input.sessionKey,
      message: input.prompt,
      idempotencyKey: randomUUID(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
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
  const state: RunnerState = { runId: null, helloOk: false };

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
    send(buildChatSendRequest(input));
  };

  ws.on("open", () => {
    if (debug) console.log("[ws] open", winning.url);
    // Do nothing here — wait for connect.challenge from the server. Per
    // the protocol, the first frame the server sends is the challenge,
    // and the client's first frame must be the `connect` request.
  });

  ws.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    if (!text) return;
    if (debug) console.log("[ws] msg", text.slice(0, 240));

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
      // hello-ok transitions to chat.send
      const sawHelloOk = events.some((e) => e.type === "session");
      if (sawHelloOk) {
        sendChatIfReady();
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
