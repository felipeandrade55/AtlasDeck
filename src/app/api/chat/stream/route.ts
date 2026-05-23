/**
 * POST /api/chat/stream
 *
 * Streams a chat turn from OpenClaw back to the browser as Server-Sent
 * Events. The route is the orchestrator between three things:
 *
 *   1. chat-db    -> persists user/assistant messages and tracks tokens
 *   2. openclaw-runner -> spawns the OpenClaw CLI and emits typed events
 *   3. SSE stream -> forwards each event to the browser as it arrives
 *
 * The browser sends the user's text plus an optional threadId/agentId.
 * If no thread exists a new one is created. The route appends the user
 * message immediately, then opens an SSE stream that:
 *   - emits a `meta` event with thread/message ids so the UI can render
 *   - forwards every runner event as `token`, `tool_use`, `tool_result`,
 *     `usage`, `error`, and finally `done`
 *   - persists the assistant message progressively (content updated on
 *     each token) so refreshing the page mid-stream recovers the
 *     partial reply.
 */
import { NextRequest } from "next/server";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  updateMessage,
  updateThread,
} from "@/lib/chat-db";
import { runOpenClawChat, type RunnerEvent } from "@/lib/openclaw-runner";
import { logActivity, updateActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatStreamBody {
  threadId?: string;
  agentId?: string;
  message?: string;
  workspace?: string;
  /**
   * When true, the route appends a routing hint to the prompt sent to
   * OpenClaw asking the agent to reply directly in this session instead
   * of routing the real answer to another channel (Telegram, etc.). The
   * hint is NOT persisted on the user message — chat-db stores the
   * original prompt so the conversation log stays clean.
   */
  forceInline?: boolean;
}

const FORCE_INLINE_HINT =
  "\n\n[atlas:hint] Esta sessão é `web:atlasdeck` e o usuário está olhando aqui agora. " +
  "Responda diretamente nesta sessão com o conteúdo completo. NÃO use `sessions_send`, " +
  "nem trate este turno como notificação para outro canal (Telegram/etc.). " +
  "Mande a resposta real aqui no chat.";

function sseLine(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function deriveTitleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (!collapsed) return "Nova conversa";
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimings(
  timings: Record<string, number>,
  baseDetail: string | null,
): string {
  const parts: string[] = [];
  if (timings["handshake"] != null) parts.push(`handshake=${formatMs(timings["handshake"])}`);
  if (timings["hello-ok"] != null) parts.push(`hello-ok=${formatMs(timings["hello-ok"])}`);
  if (timings["first-delta"] != null) {
    parts.push(`1st-delta=${formatMs(timings["first-delta"])}`);
  }
  if (timings["final"] != null) parts.push(`final=${formatMs(timings["final"])}`);

  // If 1st-delta arrived basically at the same instant as final, the
  // gateway is buffering the whole reply instead of streaming. That
  // matches the OpenClaw default `agents.defaults.blockStreamingDefault: "off"`.
  // Surface an actionable hint instead of leaving the operator guessing.
  if (
    timings["first-delta"] != null &&
    timings["final"] != null &&
    Math.abs(timings["final"] - timings["first-delta"]) < 100
  ) {
    parts.push(
      "buffered (set agents.defaults.blockStreamingDefault=on in openclaw.json)",
    );
  }

  const stripped = baseDetail ? baseDetail.split("· ").filter((s) => !s.includes("=") && !s.includes("buffered")).join("· ") : "";
  const head = stripped ? stripped.trim().replace(/·\s*$/, "") : "";
  return head ? `${head} · ${parts.join(" · ")}` : parts.join(" · ");
}

export async function POST(req: NextRequest) {
  let body: ChatStreamBody;
  try {
    body = (await req.json()) as ChatStreamBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const prompt = (body.message ?? "").trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: "Missing 'message'" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const agentId = body.agentId?.trim() || "main";

  let thread = body.threadId ? getThread(body.threadId) : null;
  if (!thread) {
    thread = createThread({
      agent_id: agentId,
      workspace: body.workspace ?? null,
      source: "web",
      title: deriveTitleFromPrompt(prompt),
    });
  } else if (thread.agent_id !== agentId) {
    thread = updateThread(thread.id, { agentId }) ?? thread;
  }

  const userMsg = appendMessage({
    thread_id: thread.id,
    role: "user",
    content: prompt,
    status: "complete",
  });

  // Mission Control activity: open a "running" entry for this chat turn.
  // Finalized in the stream's finally block with duration + token usage,
  // so the dashboard reflects every chat interaction (not just CRUD).
  const turnStart = Date.now();
  const previewSrc = prompt.replace(/\s+/g, " ").trim();
  const preview = previewSrc.length > 80 ? `${previewSrc.slice(0, 77)}…` : previewSrc;
  let activityId: string | null = null;
  try {
    const act = logActivity("message", `Chat: ${preview}`, "running", {
      agent: agentId,
      metadata: { threadId: thread.id, source: "web" },
    });
    activityId = act.id;
  } catch (err) {
    console.warn("[chat/stream] logActivity failed:", err);
  }

  // forceInline appends a routing hint *only* to the prompt we send to
  // OpenClaw — the persisted user message above stays as the original
  // text the operator typed, so the thread history doesn't get polluted
  // when the user clicks "Forçar resposta direta" from the stub banner.
  const effectivePrompt = body.forceInline ? `${prompt}${FORCE_INLINE_HINT}` : prompt;

  // Pre-create assistant message in streaming state so the UI gets an ID up front.
  const assistantMsg = appendMessage({
    thread_id: thread.id,
    role: "assistant",
    content: "",
    status: "streaming",
  });

  const history = listMessages({ threadId: thread.id, limit: 50 })
    .filter((m) => m.id !== assistantMsg.id && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });

  const encoder = new TextEncoder();
  let assembled = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let sessionId: string | null = null;
  let providerForTurn: string | null = null;
  let providerDetailForTurn: string | null = null;
  const timings: Record<string, number> = {};
  let bufferedDetected = false;
  let stubReplyDetected = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseLine(event, data)));
        } catch {
          // Browser may have closed the connection; ignore
        }
      };

      send("meta", {
        threadId: thread!.id,
        userMessageId: userMsg.id,
        assistantMessageId: assistantMsg.id,
        agentId,
      });

      // Heartbeat every 15s to keep proxies/clients alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {}
      }, 15_000);

      try {
        for await (const evt of runOpenClawChat({
          agentId,
          prompt: effectivePrompt,
          threadId: thread!.id,
          sessionId: thread!.source_session_id,
          workspace: thread!.workspace,
          history,
          signal: ac.signal,
        })) {
          handleEvent(evt, send);
          if (evt.type === "done" || evt.type === "error") break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("error", { message });
        updateMessage(assistantMsg.id, {
          status: "error",
          error: message,
        });
      } finally {
        clearInterval(heartbeat);
        // Final persistence: mark assistant as complete with whatever we got
        const current = updateMessage(assistantMsg.id, {
          content: assembled,
          tokensIn,
          tokensOut,
          cost,
          status: assembled ? "complete" : "error",
          error: assembled ? null : "Resposta vazia do OpenClaw",
        });

        if (activityId) {
          try {
            updateActivity(activityId, assembled ? "success" : "error", {
              duration_ms: Date.now() - turnStart,
              tokens_used: tokensIn + tokensOut,
            });
          } catch (err) {
            console.warn("[chat/stream] updateActivity failed:", err);
          }
        }

        // If we learned the OpenClaw session id, attach it to the thread
        if (sessionId && !thread!.source_session_id) {
          updateThread(thread!.id, {
            metadata: { ...thread!.metadata, openclawSessionId: sessionId },
          });
        }

        send("done", {
          assistantMessageId: assistantMsg.id,
          content: current?.content ?? assembled,
          tokensIn,
          tokensOut,
          cost,
          provider: providerForTurn,
          providerDetail: providerDetailForTurn,
          buffered: bufferedDetected,
          stubReply: stubReplyDetected,
        });
        try {
          controller.close();
        } catch {}
      }

      function handleEvent(evt: RunnerEvent, send: (e: string, d: unknown) => void) {
        switch (evt.type) {
          case "provider":
            // Tells the UI which backend (ws / cli / ollama) actually
            // answered this turn. Useful diagnostic when the WS path
            // falls back transparently and the user wonders why
            // latency stayed high.
            send("provider", { provider: evt.provider, detail: evt.detail });
            providerForTurn = evt.provider;
            providerDetailForTurn = evt.detail ?? null;
            break;
          case "token":
            assembled += evt.delta;
            // Detect "stub reply" pattern: the agent acknowledges that
            // it routed the real answer elsewhere instead of replying
            // in the chat. Common phrases observed:
            //   "Respondi no chat"
            //   "Respondi no chat com ..."
            // These usually mean the agent's AGENTS.md/TOOLS.md is
            // configured to deliver via `sessions_send` to another
            // channel (Telegram, etc.) and treat /chat as notification.
            if (!stubReplyDetected) {
              const trimmedLow = assembled.trim().toLowerCase();
              if (
                trimmedLow.startsWith("respondi no chat") ||
                trimmedLow.startsWith("respondi via chat") ||
                trimmedLow.startsWith("já respondi") ||
                trimmedLow.startsWith("ja respondi")
              ) {
                stubReplyDetected = true;
              }
            }
            send("token", { delta: evt.delta });
            // Throttled persistence: update content every ~256 chars
            if (assembled.length % 256 < evt.delta.length) {
              updateMessage(assistantMsg.id, { content: assembled });
            }
            break;
          case "tool_use":
            send("tool_use", { id: evt.id, name: evt.name, input: evt.input });
            appendMessage({
              thread_id: thread!.id,
              role: "tool_use",
              content: evt.name,
              tool_name: evt.name,
              tool_input: evt.input,
              status: "complete",
            });
            break;
          case "tool_result":
            send("tool_result", { id: evt.id, output: evt.output });
            appendMessage({
              thread_id: thread!.id,
              role: "tool_result",
              content: evt.output.slice(0, 4000),
              tool_output: evt.output,
              status: "complete",
            });
            break;
          case "session":
            sessionId = evt.sessionId;
            send("session", { sessionId: evt.sessionId });
            break;
          case "usage":
            tokensIn = evt.tokensIn;
            tokensOut = evt.tokensOut;
            cost = evt.cost ?? cost;
            send("usage", {
              tokensIn,
              tokensOut,
              cost,
              model: evt.model,
            });
            break;
          case "timing":
            // Track the gateway phase timings so the bubble badge can
            // explain WHERE the latency is going (handshake vs LLM
            // first-byte vs LLM final). Update the provider detail
            // and re-emit the provider event so the badge refreshes
            // live as each phase reports.
            timings[evt.phase] = evt.ms;
            providerDetailForTurn = formatTimings(timings, providerDetailForTurn);
            // Heuristic: gateway buffered the reply if first-delta and
            // final arrived within 100ms of each other.
            if (
              timings["first-delta"] != null &&
              timings["final"] != null &&
              Math.abs(timings["final"] - timings["first-delta"]) < 100
            ) {
              bufferedDetected = true;
            }
            if (providerForTurn) {
              send("provider", {
                provider: providerForTurn,
                detail: providerDetailForTurn,
                buffered: bufferedDetected,
              });
            }
            break;
          case "done":
            // Handled by the loop break — finally block does the persistence.
            break;
          case "error":
            send("error", { message: evt.message, code: evt.code });
            updateMessage(assistantMsg.id, {
              status: "error",
              error: evt.message,
            });
            break;
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
