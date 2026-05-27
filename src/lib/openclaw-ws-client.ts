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

const FRAME_LOG_MAX = 80;
const FRAME_LOG_TRUNC = 800;

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
 * Strict text extractor for `state=delta` frames — ONLY pulls from the
 * named text fields. No recursive fallback, because per-delta we'd
 * rather miss text than scrape a runId/sessionId out of the frame and
 * paste it into the bubble as if it were a reply chunk (the recursive
 * pass is reserved for `state=final` where missing text means the
 * bubble would be empty anyway).
 */
function extractDeltaText(payload: Record<string, unknown>): string {
  for (const field of KNOWN_TEXT_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

// Streams (within `event: "agent"`) that carry no assistant text and
// should be ignored entirely. These are the gateway's own lifecycle
// signals + health pings + Codex-app server bookkeeping — extracting
// from them would just dump runIds and timestamps into the bubble.
const META_AGENT_STREAMS = new Set([
  "lifecycle",
  "health",
  "telemetry",
  "ping",
  "pong",
  "ack",
  "session",
  "session.update",
]);

function isMetaAgentStream(stream: string): boolean {
  if (!stream) return false;
  if (META_AGENT_STREAMS.has(stream)) return true;
  // Codex-app-server internal streams are all bookkeeping (lifecycle,
  // exec, etc.). The assistant's actual reply lands on streams without
  // this prefix (typically `item`, `message`, `output`, …).
  if (stream.startsWith("codex_app_server")) return true;
  if (stream.startsWith("lifecycle")) return true;
  if (stream.startsWith("health")) return true;
  return false;
}

// Within a `stream: "item"` frame, the `data.kind` (or `data.type`)
// tells us WHAT kind of item this is. The Codex/Responses item types
// that are NOT visible assistant replies:
//   - reasoning / analysis / thinking      → the model's internal CoT
//   - tool_call / tool_result / function_call → tool invocations (handled separately)
//   - web_search / file_search             → search tool flavors
//   - userMessage                          → echo of the user's prompt
// Anything else (message, agent_message, output_text, response, …) IS
// the assistant's text reply and we extract it.
const NON_REPLY_ITEM_KINDS = new Set([
  "reasoning",
  "analysis",
  "thinking",
  "tool_call",
  "tool_result",
  "function_call",
  "function_response",
  "web_search",
  "file_search",
  "code_interpreter",
  "userMessage",
  "user_message",
  "system_message",
  "developer_message",
]);

function isNonReplyItemKind(kind: string): boolean {
  if (!kind) return false;
  return NON_REPLY_ITEM_KINDS.has(kind);
}

// Names of tools whose invocation we recognise as "the agent is routing
// the reply somewhere else instead of returning it as a message item".
// Frame [11] of the user's trace showed this:
//   { kind: "tool", name: "message", suppressChannelProgress: true }
// which means a custom tool called `message` was invoked — typically
// these tools push the answer to Telegram / another channel rather than
// streaming it back to the WS caller. We don't try to *extract* the
// reply from the tool input (the input may not even be the final text);
// instead we flag the situation so the UI can show a fix-it banner.
const ROUTING_TOOL_NAMES = new Set([
  "message",
  "send_message",
  "sessions_send",
  "telegram_send",
  "telegram",
  "whatsapp_send",
  "whatsapp",
  "reply",
  "send",
  "notify",
  "broadcast",
]);

function isRoutingToolName(name: string): boolean {
  if (!name) return false;
  if (ROUTING_TOOL_NAMES.has(name)) return true;
  const low = name.toLowerCase();
  if (low.includes("send")) return true;
  if (low.includes("telegram")) return true;
  if (low.includes("whatsapp")) return true;
  if (low.includes("notify")) return true;
  return false;
}

/**
 * Best-effort extraction of the assistant text from a tool-call frame.
 * When the agent routes a reply through a tool like `message`, the
 * actual reply text is usually buried in the tool's input arguments
 * (`data.input.text`, `data.args.message`, etc.). Recovering it lets
 * us still render *something* in the bubble even before the user
 * fixes their AGENTS.md to stop using the routing tool.
 */
function extractToolReplyText(data: Record<string, unknown>): string {
  // Common input wrappers
  const wrappers: Record<string, unknown>[] = [data];
  for (const key of ["input", "args", "arguments", "params", "parameters"]) {
    const v = data[key];
    if (isRecord(v)) wrappers.push(v as Record<string, unknown>);
  }
  // Common text-bearing fields
  const fields = ["text", "message", "content", "reply", "body", "output"];
  for (const w of wrappers) {
    for (const f of fields) {
      const v = w[f];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  return "";
}

/**
 * Extracts assistant text from an `event: "agent"` payload. OpenClaw's
 * current gateway wraps the agent's stream into a transport envelope
 * with a `stream` discriminator and a `data` (or similar) sub-object
 * shaped like the underlying model's streaming format (Codex / OpenAI
 * Responses API, with `item.content[].text` chunks).
 *
 * Special case: when `stream === "item"` the `data.kind` (or `data.type`)
 * field tells us whether this item is the assistant's actual reply or
 * an internal step (reasoning, tool call, user echo, etc.). We MUST
 * skip non-reply kinds — otherwise the bubble would fill up with the
 * model's chain-of-thought, which is meant to stay internal.
 */
function extractAgentEventText(
  payload: Record<string, unknown>,
  stream: string,
): string {
  // Top-level known fields (deltaText / text / content / etc.)
  const top = extractDeltaText(payload);
  if (top) return top;

  // `data` sub-object — the gateway nests the model frame in here.
  const data = isRecord(payload.data) ? (payload.data as Record<string, unknown>) : null;
  if (data) {
    // Filter by item kind/type when this is a stream:"item" frame —
    // reasoning / tool / userMessage items don't carry visible reply.
    if (stream === "item") {
      const kind =
        typeof data.kind === "string"
          ? data.kind
          : typeof data.type === "string"
          ? data.type
          : "";
      if (isNonReplyItemKind(kind)) {
        return "";
      }
    }

    const dataText = extractDeltaText(data);
    if (dataText) return dataText;

    // Codex item shape: { item: { content: [{ type: "output_text", text: "…" }] } }
    const item = isRecord(data.item) ? (data.item as Record<string, unknown>) : null;
    if (item) {
      const itemText = extractItemText(item);
      if (itemText) return itemText;
    }

    // Some builds put the textual delta straight in `delta` as a string
    if (typeof data.delta === "string" && data.delta.length > 0) {
      return data.delta;
    }
    // Or `delta.text` / `delta.content` when it's an object
    const delta = isRecord(data.delta) ? (data.delta as Record<string, unknown>) : null;
    if (delta) {
      const dt = extractDeltaText(delta);
      if (dt) return dt;
    }
  }

  // Direct `item` at top level (some builds skip the `data` wrap)
  const directItem = isRecord(payload.item) ? (payload.item as Record<string, unknown>) : null;
  if (directItem) {
    const itemText = extractItemText(directItem);
    if (itemText) return itemText;
  }

  // Top-level `delta` string
  if (typeof payload.delta === "string" && payload.delta.length > 0) {
    return payload.delta;
  }

  return "";
}

function extractItemText(item: Record<string, unknown>): string {
  // Codex: item.content is an array of content parts, each may have
  // type="output_text"|"text"|"input_text" and a `text` string field.
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content as unknown[]) {
      if (!isRecord(part)) continue;
      const partRec = part as Record<string, unknown>;
      const type = typeof partRec.type === "string" ? partRec.type : "";
      // Skip non-text parts (image, tool, etc.)
      if (type && !/text|output_text|input_text/i.test(type)) continue;
      if (typeof partRec.text === "string" && partRec.text) {
        parts.push(partRec.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  // Flat: item.text / item.delta / item.message
  if (typeof item.text === "string" && item.text) return item.text;
  if (typeof item.delta === "string" && item.delta) return item.delta;
  if (typeof item.message === "string" && item.message) return item.message;
  if (typeof item.value === "string" && item.value) return item.value;
  return "";
}

/**
 * Pulls the visible assistant reply out of a `chat.event` payload regardless
 * of where the gateway placed it. Different OpenClaw builds put the text in
 * different fields: streaming builds use `deltaText`; buffered builds put
 * the whole answer under `text`, `payloads[0].text`, or nest the full CLI
 * envelope under `result.payloads[0].text` /
 * `result.meta.finalAssistantVisibleText`. We accept any of them, plus a
 * recursive longest-string fallback for builds with a not-yet-mapped
 * field name. Use only for terminal `final` frames — for live `delta`
 * frames use `extractDeltaText` to avoid scraping metadata.
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
      let code = err && typeof err.code === "string" ? err.code : undefined;
      // Re-classify the well-known "device identity required" rejection
      // so the runner / UI can route it to the dangerouslyDisableDeviceAuth
      // auto-fix instead of treating it as a generic chat error. The
      // gateway sometimes returns this as message-only (no code), so we
      // sniff both fields.
      const cause =
        err && typeof err.cause === "string" ? (err.cause as string) : "";
      if (
        /device.{0,10}(identity\s+)?required/i.test(msg) ||
        /device.required/i.test(cause) ||
        /pairing.required/i.test(msg) ||
        code === "device-required" ||
        code === "DEVICE_REQUIRED"
      ) {
        code = "WS_DEVICE_REQUIRED";
      } else if (
        /invalid\s+connect\s+params/i.test(msg) ||
        /must\s+have\s+required\s+property/i.test(msg) ||
        /unexpected\s+property/i.test(msg)
      ) {
        // Schema-validation rejection — keep the gateway's full
        // message so the operator sees exactly which field is wrong.
        // Distinct code lets the UI offer a different banner ("você
        // precisa atualizar o AtlasDeck" vs "ative o auth bypass").
        code = "WS_INVALID_PARAMS";
      }
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

  // Server event: chat streaming. We use a conservative allow-list
  // (chat.event + a handful of well-known aliases) because the prior
  // permissive deny-list ended up extracting metadata strings from
  // lifecycle / telemetry / exec frames as if they were reply text
  // (runIds, sessionIds, "codex_app_server.lifecycle"…) and dumping
  // that junk into the bubble. Better to miss a brand-new event name
  // and surface an empty-reply diagnostic than to fabricate garbage.
  if (frameType === "event") {
    const eventName = typeof raw.event === "string" ? raw.event : "";
    const payload = isRecord(raw.payload) ? (raw.payload as Record<string, unknown>) : {};

    // Allow-list of event names that legitimately carry assistant text
    // OR a state machine (delta/final/aborted/error). Everything else
    // is ignored for text extraction. `agent` is the catch-all envelope
    // current OpenClaw gateways use for the underlying model stream —
    // it has a `stream` discriminator inside `payload` we sub-filter on.
    const CHAT_EVENTS = new Set([
      "chat.event",
      "chat",
      "chat.delta",
      "chat.token",
      "chat.message",
      "chat.final",
      "agent",
      "agent.delta",
      "agent.message",
      "assistant.delta",
      "assistant.message",
      "message.delta",
    ]);
    const isChatEvent = CHAT_EVENTS.has(eventName);

    if (isChatEvent) {
      if (typeof payload.runId === "string") state.runId = payload.runId;
      const eventState = typeof payload.state === "string" ? payload.state : undefined;
      const stream = typeof payload.stream === "string" ? payload.stream : "";

      // For `event:"agent"` frames, the gateway sub-types via the
      // `stream` field. Bookkeeping streams (lifecycle/health/codex_app_server_*)
      // never carry text — skip them outright. Otherwise treat the
      // frame as a delta-shaped chunk and try the Codex-aware
      // extractor.
      if (eventName === "agent") {
        if (!stream || isMetaAgentStream(stream)) {
          return events;
        }
        // Stream:item kind:tool — detect tools that route the reply
        // elsewhere (Telegram, sessions_send, …) and try to salvage
        // text from the tool input so the bubble is at least usable.
        if (stream === "item") {
          const data = isRecord(payload.data)
            ? (payload.data as Record<string, unknown>)
            : null;
          const kind =
            typeof data?.kind === "string" ? (data.kind as string) : "";
          const toolName =
            typeof data?.name === "string" ? (data.name as string) : "";
          if (kind === "tool" && isRoutingToolName(toolName)) {
            // Surface the tool_use so the UI can show a banner and
            // (eventually) the operator can wire an auto-fix that
            // forbids this tool for web:atlasdeck.
            events.push({
              type: "tool_use",
              name: toolName,
              input: data ?? {},
            });
            // Best-effort recovery of the visible text from the tool's
            // input — works when the tool was called with
            //   { text: "hello", to: "..." } or similar shapes.
            if (data && !state.tokensEmitted) {
              const salvaged = extractToolReplyText(data);
              if (salvaged) {
                events.push({ type: "token", delta: salvaged });
                state.tokensEmitted = true;
              }
            }
            return events;
          }
        }
        const text = extractAgentEventText(payload, stream);
        if (text) {
          events.push({ type: "token", delta: text });
          state.tokensEmitted = true;
        }
        return events;
      }

      // Treat events without an explicit state but with a delta-style
      // name (chat.delta, chat.token, etc.) as deltas. Same for
      // chat.final → final.
      const inferredState =
        eventState ||
        (eventName === "chat.delta" || eventName === "chat.token" || eventName === "agent.delta" || eventName === "assistant.delta" || eventName === "message.delta"
          ? "delta"
          : eventName === "chat.final"
          ? "final"
          : undefined);

      // Pure delta path: extract text but ONLY from well-known fields.
      // The recursive longest-string fallback (extractPayloadText pass
      // 3) is reserved for `final` because that's the only state where
      // we'd rather surface *something* than nothing. Per-delta we'd
      // rather miss text than paste in a runId.
      if (inferredState === "delta") {
        const text = extractDeltaText(payload);
        if (text) {
          events.push({ type: "token", delta: text });
          state.tokensEmitted = true;
        }
      }

      switch (inferredState) {
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
  // OpenClaw gateway 2026.5+ has a STRICT JSON-schema for connect
  // params — it rejects both extra AND missing fields. Empirically:
  //   - `platform`  REQUIRED  (gateway returns "must have required
  //                            property 'platform'" without it)
  //   - `client.mode: "backend"` + token → skips device pairing on
  //     loopback (still need dangerouslyDisableDeviceAuth=true in
  //     openclaw.json for some recent builds — the auth auto-fix
  //     handles that)
  //   - `scopes/caps/commands/permissions/locale/userAgent` accepted
  //     as long as they're well-formed; sending them keeps the
  //     handshake working across the largest range of gateway versions
  // The doc at docs.openclaw.ai/gateway/protocol shows a "minimal"
  // example without `platform`, but real builds reject that — keep
  // the wider shape that mirrors what the OpenClaw CLI itself sends.
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
