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
import { publishEvent } from "@/lib/live-events";
import { createTask, updateTask } from "@/lib/tasks-db";
import { getSettings } from "@/lib/memory-db";
import { cityFromAddress, shortCityName, type NominatimAddress } from "@/lib/location-display";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatStreamBody {
  threadId?: string;
  agentId?: string;
  message?: string;
  workspace?: string;
  forceInline?: boolean;
  thinking?: string;
  fastMode?: boolean;
  // Browser geolocation snapshot for this turn — sent by useChatStream
  // when the user has granted permission. Used to override the saved
  // home location while traveling so Jarvis says "São Luís" instead of
  // the stale "Santa Helena de Goiás" home label.
  liveLat?: number;
  liveLon?: number;
}

// Web chat turns were missing the user's actual location, so the LLM
// would default to "SP" / "São Paulo" no matter where the user lived.
// Inject the real coordinates + label + timezone + local datetime so
// the agent grounds its small-talk ("bom dia, hoje em X o clima...")
// in reality instead of hallucinating. Empty string when location is
// not configured yet — better silence than a wrong fallback.
//
// When the turn looks like a delivery/order task AND the user has saved
// a full street address, also append a [atlas:delivery_address] block so
// Jarvis can place real orders without having to ask "qual seu endereço?"
// every time. The trigger is intentionally narrow so daily small-talk
// doesn't leak the street address into prompts.
const DELIVERY_INTENT_RE =
  /\b(peça|peca|pedir|peço|peco|pede|encomende|encomenda|encomendar|comprar|compra|compre|compra(r)?\s+(online|pela\s+internet)|entrega(r|m)?|entregue|delivery|pizza|hamb[uú]rguer|hamburguer|lanche|jantar|almo[çc]o|caf[eé]\s+da\s+manh[ãa]|mercado|supermercado|farm[áa]cia|rem[eé]dio|uber\s*eats|ifood|i-?food|rappi|99food|aliexpress|amazon|mercado\s+livre|magalu|magazine\s+luiza|americanas|shopee|shein|correios|enviar?\s+(um\s+)?pacote|encomenda)\b/i;

function hasDeliveryIntent(prompt: string): boolean {
  if (!prompt) return false;
  return DELIVERY_INTENT_RE.test(prompt);
}

function formatDeliveryAddress(s: ReturnType<typeof getSettings>): string | null {
  const segments: string[] = [];
  if (s.home_address_street) {
    segments.push(
      s.home_address_number
        ? `${s.home_address_street}, ${s.home_address_number}`
        : s.home_address_street,
    );
  }
  if (s.home_address_complement) segments.push(s.home_address_complement);
  if (s.home_address_neighborhood) segments.push(s.home_address_neighborhood);
  if (s.home_address_city) {
    segments.push(
      s.home_address_state
        ? `${s.home_address_city} - ${s.home_address_state}`
        : s.home_address_city,
    );
  } else if (s.home_address_state) {
    segments.push(s.home_address_state);
  }
  if (s.home_address_postal_code) segments.push(`CEP ${s.home_address_postal_code}`);
  return segments.length ? segments.join(", ") : null;
}

// In-memory reverse-geocode cache. Nominatim rate-limits ~1 req/s/IP and
// charging that per chat turn would also add 500ms+ of latency before
// the first token. Key is lat/lon rounded to 3 decimals (~100m), which
// is more than enough for city-level grounding. TTL 12h.
const REVERSE_GEO_CACHE = new Map<string, { label: string; expiresAt: number }>();

async function reverseGeocodeCity(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = REVERSE_GEO_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.label;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lon}`,
      {
        headers: {
          "Accept-Language": "pt-BR",
          "User-Agent": "AtlasDeck/1.0 (https://atlasdeck.egis.app.br)",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string; address?: NominatimAddress };
    const label = cityFromAddress(data.address) || shortCityName(data.display_name) || null;
    if (label) {
      REVERSE_GEO_CACHE.set(key, {
        label,
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
    }
    return label;
  } catch {
    return null;
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Threshold for "you're not at home anymore". 2km handles dense-urban
// GPS noise (multi-block error in tall-building areas) without flagging
// the user as traveling when they're really at the kitchen table.
const TRAVELING_DISTANCE_KM = 2;

async function buildUserContextPreamble(
  rawPrompt: string,
  live?: { lat: number; lon: number } | null,
): Promise<string> {
  try {
    const s = getSettings();
    const hasHome = s.home_lat != null && s.home_lon != null;
    if (!hasHome && !live) return "";

    const homeTz = s.home_timezone || null;
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    let nowPlace: string;
    let nowLat: number;
    let nowLon: number;
    let traveling = false;
    let homePlace: string | null = null;

    if (live && hasHome) {
      const distance = haversineKm(live.lat, live.lon, s.home_lat!, s.home_lon!);
      if (distance > TRAVELING_DISTANCE_KM) {
        traveling = true;
        const liveLabel = await reverseGeocodeCity(live.lat, live.lon);
        nowPlace = liveLabel || `${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}`;
        nowLat = live.lat;
        nowLon = live.lon;
        homePlace =
          s.home_label?.trim() ||
          `${s.home_lat!.toFixed(4)}, ${s.home_lon!.toFixed(4)}`;
      } else {
        // Live confirms the user is at home — use the human-friendly
        // home label instead of the noisy live coords.
        nowPlace =
          s.home_label?.trim() ||
          `${s.home_lat!.toFixed(4)}, ${s.home_lon!.toFixed(4)}`;
        nowLat = s.home_lat!;
        nowLon = s.home_lon!;
      }
    } else if (live) {
      const liveLabel = await reverseGeocodeCity(live.lat, live.lon);
      nowPlace = liveLabel || `${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}`;
      nowLat = live.lat;
      nowLon = live.lon;
    } else {
      // hasHome === true (early-return otherwise)
      nowPlace =
        s.home_label?.trim() ||
        `${s.home_lat!.toFixed(4)}, ${s.home_lon!.toFixed(4)}`;
      nowLat = s.home_lat!;
      nowLon = s.home_lon!;
    }

    // When traveling, the saved home timezone is wrong — use the device
    // tz so "agora local" reflects where the user actually is.
    const tz = traveling ? deviceTz : homeTz || deviceTz;
    const nowLocal = new Date().toLocaleString("pt-BR", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "short",
    });

    const lines: string[] = [];
    lines.push(
      `[atlas:context] Você está AGORA em: ${nowPlace} ` +
        `(lat ${nowLat.toFixed(4)}, lon ${nowLon.toFixed(4)}). ` +
        `Fuso horário: ${tz}. Agora local: ${nowLocal}.`,
    );
    if (traveling && homePlace) {
      lines.push(
        `Seu endereço fixo (casa) está em ${homePlace} — use o "agora" para clima/hora/contexto local ` +
          `e o "casa" apenas como referência ao endereço fixo ou entregas para a residência.`,
      );
    } else {
      lines.push(
        `Use ESTA localização ao mencionar cidade, clima, hora ou contexto regional — ` +
          `NÃO assuma São Paulo / SP nem qualquer outra cidade.`,
      );
    }
    const blocks: string[] = [lines.join(" ")];

    if (hasDeliveryIntent(rawPrompt)) {
      const fullAddress = formatDeliveryAddress(s);
      if (fullAddress) {
        const reference = s.home_address_reference
          ? ` Ponto de referência: ${s.home_address_reference}.`
          : "";
        const travelHint = traveling
          ? ` ATENÇÃO: o usuário está viajando agora (${nowPlace}); confirme se a entrega é para a casa ou para a localização atual antes de finalizar.`
          : "";
        blocks.push(
          `[atlas:delivery_address] Endereço de entrega cadastrado (residência): ${fullAddress}.${reference} ` +
            `Use estes dados para preencher formulários de pedido, calcular taxa de entrega, ` +
            `confirmar o endereço com o usuário antes de finalizar.${travelHint}`,
        );
      } else {
        blocks.push(
          `[atlas:delivery_address] O usuário ainda NÃO cadastrou endereço completo para entregas. ` +
            `Antes de finalizar qualquer pedido, peça gentilmente os dados (rua, número, complemento, bairro, CEP) ` +
            `ou oriente a abrir o LocationPicker no dashboard (ícone de engrenagem do WeatherWidget) para salvá-los.`,
        );
      }
    }

    return blocks.join("\n") + "\n\n";
  } catch {
    return "";
  }
}

const FORCE_INLINE_HINT =
  "\n\n[atlas:hint] Esta sessão é `web:atlasdeck` e o usuário está olhando aqui agora. " +
  "Responda diretamente nesta sessão com o conteúdo completo. " +
  // Anti-tool-routing: a recorrência do bug é o agente invocar uma
  // tool customizada (geralmente chamada `message`, `send_message`,
  // `sessions_send`, `telegram_send`) que entrega a resposta em outro
  // canal e devolve um ack vazio aqui. Para web:atlasdeck queremos
  // SEMPRE o reply como assistant message item direto, jamais via tool.
  "NÃO chame as tools `message`, `send_message`, `sessions_send`, `telegram_send`, " +
  "`whatsapp_send`, `reply`, `send`, `notify` nem qualquer tool de roteamento. " +
  "Responda como ASSISTANT MESSAGE ITEM normal — texto direto, sem tool calls de envio. " +
  "Não trate este turno como notificação para outro canal (Telegram/WhatsApp/etc.). " +
  // Anti-HEARTBEAT-leak: ignore qualquer pre-prompt que faria o agente
  // ecoar HEARTBEAT.md / responder HEARTBEAT_OK. Esta é pergunta direta.
  "Esta mensagem NÃO é um heartbeat, ping de cron, ou briefing matinal — " +
  "é uma pergunta direta do usuário. Não leia HEARTBEAT.md, não responda " +
  "HEARTBEAT_OK, não eche templates do AGENTS.md. Responda em pt-BR direto.";

function sseLine(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function deriveTitleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (!collapsed) return "Nova conversa";
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

// Heuristic: only promote a chat turn into a kanban card when it looks
// like real work. Trivia like "me explique BGP em 3 linhas" should NOT
// pollute the Live Mission board — only substantial requests or those
// with explicit "do X" verbs should. Threshold + verb list chosen so
// short Q&A pings stay out while page/product/build/publish requests
// always trigger.
const KANBAN_LENGTH_THRESHOLD = 120;
const KANBAN_WORK_VERBS_RE =
  /\b(crie|criar|cria|criem|fa[çc]a|fa[çc]am|fazer|construa|construir|constr[oó]i|implemente|implementar|publique|publicar|publica|desenvolva|desenvolver|monte|montar|gere|gerar|projete|projetar|configure|configurar|build|create|implement|make|develop|deploy|publish|launch|generate|design)\b/i;

function shouldCreateKanbanTask(prompt: string): boolean {
  if (!prompt) return false;
  if (prompt.length >= KANBAN_LENGTH_THRESHOLD) return true;
  return KANBAN_WORK_VERBS_RE.test(prompt);
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    const s = input.replace(/\s+/g, " ").trim();
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  }
  try {
    const s = JSON.stringify(input).replace(/\s+/g, " ");
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return "";
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimings(
  timings: Record<string, number>,
  baseDetail: string | null,
  providerForTurn?: string | null,
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
    providerForTurn !== "ws" &&
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

  // Always append the inline hint for web sessions to prevent the agent
  // from routing the response via tools like 'message' or 'telegram_send'
  // and causing buffering/stubs. Prepend the location/datetime context so
  // the agent grounds its replies in the user's real city instead of
  // hallucinating São Paulo.
  const live =
    typeof body.liveLat === "number" &&
    typeof body.liveLon === "number" &&
    body.liveLat >= -90 &&
    body.liveLat <= 90 &&
    body.liveLon >= -180 &&
    body.liveLon <= 180
      ? { lat: body.liveLat, lon: body.liveLon }
      : null;
  const userContext = await buildUserContextPreamble(prompt, live);
  const effectivePrompt = `${userContext}${prompt}${FORCE_INLINE_HINT}`;

  // Pre-create assistant message in streaming state so the UI gets an ID up front.
  const assistantMsg = appendMessage({
    thread_id: thread.id,
    role: "assistant",
    content: "",
    status: "streaming",
  });

  // Auto-promote substantial chat turns into kanban cards so the user
  // can watch Jarvis's real work move through the Live Mission board.
  // Trivial Q&A (short prompts without work verbs) stays out by design
  // — see shouldCreateKanbanTask. The card lives at status "inbox" here
  // and transitions to "in_progress" once the LLM emits its first token
  // (in the runner loop), then "done"/"failed" in the finally block.
  let kanbanTaskId: string | null = null;
  let kanbanTaskStarted = false;
  if (shouldCreateKanbanTask(prompt)) {
    try {
      const task = createTask({
        assigned_to: agentId,
        status: "inbox",
        title: preview,
        prompt,
        metadata: {
          origin: "chat-stream",
          threadId: thread.id,
          source: "web",
          assistantMessageId: assistantMsg.id,
        },
      });
      kanbanTaskId = task.id;
    } catch (err) {
      console.warn("[chat/stream] auto-task creation failed:", err);
    }
  }

  // Bridge chat lifecycle into the Live Mission event bus so the dashboard
  // shows activity even when the turn isn't tied to a formal task. Without
  // this the Live Activity feed stays empty while the agent is working.
  publishEvent({
    event_type: "chat.turn_started",
    agent_id: agentId,
    payload: {
      threadId: thread.id,
      preview,
      source: "web",
      taskId: kanbanTaskId,
    },
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
  // Distinct from stubReply: detects when the agent echoes the AGENTS.md
  // HEARTBEAT template instead of replying to the actual user prompt.
  // The leak looks like:
  //   "Read HEARTBEAT.md if it exists (workspace context). Follow it
  //   strictly. ... reply HEARTBEAT_OK."
  // It means the agent's system prompt is treating *every* incoming
  // message as a heartbeat ping (probably the morning-briefing cron's
  // template was made unconditional). The user sees their question
  // ignored. We surface a banner explaining how to fix AGENTS.md.
  let heartbeatLeakDetected = false;

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
          thinking: body.thinking,
          fastMode: body.fastMode,
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

        publishEvent({
          event_type: "chat.turn_completed",
          agent_id: agentId,
          payload: {
            threadId: thread!.id,
            ok: Boolean(assembled),
            duration_ms: Date.now() - turnStart,
            tokensIn,
            tokensOut,
            cost,
            taskId: kanbanTaskId,
          },
        });

        // Close out the kanban card. Success → "done" with a result
        // preview (full content lives in chat-db). Empty/error → "failed"
        // so the card surfaces in the failed lane instead of vanishing.
        if (kanbanTaskId) {
          try {
            const ok = Boolean(assembled);
            const resultPreview = ok
              ? assembled.length > 2000
                ? `${assembled.slice(0, 1997)}…`
                : assembled
              : null;
            updateTask(kanbanTaskId, {
              status: ok ? "done" : "failed",
              result: resultPreview,
              tokens_in: tokensIn,
              tokens_out: tokensOut,
              cost_cents: Math.round((cost ?? 0) * 100),
            });
          } catch (err) {
            console.warn("[chat/stream] auto-task close failed:", err);
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
          heartbeatLeak: heartbeatLeakDetected,
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
            // First real token from the LLM → flip the kanban card from
            // "inbox" to "in_progress" so the user sees motion. Guarded by
            // a flag because we only want this to happen once per turn.
            if (kanbanTaskId && !kanbanTaskStarted) {
              kanbanTaskStarted = true;
              try {
                updateTask(kanbanTaskId, { status: "in_progress" });
              } catch (err) {
                console.warn("[chat/stream] auto-task start failed:", err);
              }
            }
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
            // HEARTBEAT-leak detector: agent echoed back the system-prompt
            // template instead of replying. Triggers on any of the
            // signature phrases from the morning-briefing template.
            if (!heartbeatLeakDetected) {
              const lower = assembled.toLowerCase();
              if (
                lower.includes("heartbeat.md") ||
                lower.includes("heartbeat_ok") ||
                /reply\s+heartbeat/i.test(assembled) ||
                /read\s+heartbeat/i.test(assembled) ||
                lower.includes("do not infer or repeat old tasks")
              ) {
                heartbeatLeakDetected = true;
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
            publishEvent({
              event_type: "chat.tool_use",
              agent_id: agentId,
              payload: {
                threadId: thread!.id,
                tool: evt.name,
                input_preview: summarizeToolInput(evt.input),
              },
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
            providerDetailForTurn = formatTimings(timings, providerDetailForTurn, providerForTurn);
             // Heuristic: gateway buffered the reply if first-delta and
             // final arrived within 100ms of each other. Skip for WS which has exact tracking.
             if (
               providerForTurn !== "ws" &&
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
             if (evt.buffered !== undefined) {
               bufferedDetected = evt.buffered;
             }
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
