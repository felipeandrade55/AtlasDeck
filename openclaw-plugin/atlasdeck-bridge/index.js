/**
 * atlasdeck-bridge — OpenClaw plugin (plain ESM, zero dependencies).
 *
 *  before_prompt_build → POST {baseUrl}/api/memory/turn-context
 *      returns { prependContext } with what AtlasDeck remembers that is
 *      relevant to this message (+ continuity summary on a fresh session).
 *  agent_end           → POST {baseUrl}/api/memory/turn-capture
 *      hands the finished turn (user text + assistant reply) to AtlasDeck,
 *      which stores it and learns from it after the conversation settles.
 *  session_end         → POST {baseUrl}/api/memory/session-event
 *
 * Design rules:
 *  - Fail open. AtlasDeck down/slow ⇒ the turn proceeds without context
 *    (hard timeout, every error swallowed). The bot must never break
 *    because of memory.
 *  - Only real user turns: skip inter-session/internal inputs, heartbeat
 *    and cron runs (no sender/chat), groups (unless allowGroups), senders
 *    outside ownerSenderIds (when configured), AtlasDeck's own worker and
 *    memory prompts, and web turns (AtlasDeck injects those itself).
 *
 * Docs: docs.openclaw.ai/plugins/hooks, /plugins/hooks/prompt-and-session
 */

// No top-level await here: OpenClaw loads plugins through require(), which
// rejects ESM graphs with TLA (ERR_REQUIRE_ASYNC_MODULE — seen on 2026.11.3).
// `definePluginEntry` is an identity helper; a plain entry object is equivalent.
const define = (entry) => entry;

// AtlasDeck's own prompts (specialist tasks, memory one-shots) and web
// turns (the web route injects/captures those itself).
const SKIP_TEXT_RE = /\[atlas:(worker|memory-oneshot)\]|web:atlasdeck/;
const MEMORY_BLOCK_RE = /<atlas-memory>[\s\S]*?<\/atlas-memory>\s*/g;

function stripMemoryBlock(text) {
  return String(text || "").replace(MEMORY_BLOCK_RE, "").trim();
}

function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    const msg = m && typeof m === "object" && m.message && typeof m.message === "object" ? m.message : m;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(msg.content).trim();
    if (text) out.push({ role, text });
  }
  return out;
}

function lastUserText(event) {
  const direct = pick(
    typeof event?.currentUserMessage === "string" ? event.currentUserMessage : undefined,
    textOf(event?.currentUserMessage?.content),
  );
  if (direct) return direct;
  const msgs = normalizeMessages(event?.messages);
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return msgs[i].text;
  return typeof event?.prompt === "string" ? event.prompt : "";
}

function isGroupChat(ctx) {
  if (ctx?.isGroup === true || ctx?.chatType === "group" || ctx?.chatType === "supergroup") return true;
  const chatId = String(pick(ctx?.chatId, ctx?.channelId, "") ?? "");
  if (/@g\.us$/.test(chatId)) return true; // WhatsApp group jid
  if (/^-\d+$/.test(chatId)) return true; // Telegram group/supergroup ids are negative
  return false;
}

function sessionInfo(ctx) {
  const channel = pick(ctx?.channel, ctx?.messageProvider, ctx?.inputProvenance?.sourceChannel);
  const chatId = pick(ctx?.chatId, ctx?.channelId);
  const agentId = pick(ctx?.agentId, ctx?.agent?.id, "main");
  const sessionKey = pick(
    ctx?.sessionKey,
    ctx?.session?.key,
    chatId ? `agent:${agentId}:${channel ?? "chat"}:${chatId}` : undefined,
  );
  const sessionId = pick(ctx?.sessionId, ctx?.session?.id, ctx?.completedTurn?.sessionId);
  return { channel, chatId, agentId, sessionKey, sessionId, senderId: pick(ctx?.senderId) };
}

export default define({
  id: "atlasdeck-bridge",
  name: "AtlasDeck Memory Bridge",
  description: "Per-turn memory context and turn capture for AtlasDeck.",
  register(api) {
    const cfg = (api && api.pluginConfig) || {};
    const baseUrl = String(cfg.baseUrl || process.env.ATLASDECK_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
    const token = cfg.token || process.env.OPENCLAW_SERVICE_TOKEN || "";
    const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs) || 2500, 300), 10000);
    const owners = Array.isArray(cfg.ownerSenderIds) ? cfg.ownerSenderIds.map(String) : [];
    const skipAgents = new Set(["atlas-memory", ...(Array.isArray(cfg.skipAgents) ? cfg.skipAgents : [])]);
    const allowGroups = cfg.allowGroups === true;
    // Default: Telegram only. WhatsApp runs an assessor that talks to third
    // parties — their messages must not become the owner's memories, and
    // the owner's memories must not leak into those replies.
    const channels = new Set(
      (Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : ["telegram"]).map((c) => String(c).toLowerCase()),
    );
    const injectOn = cfg.inject !== false;
    const captureOn = cfg.capture !== false;
    const log = (msg) => {
      try {
        (api?.logger?.debug || api?.logger?.info || console.log).call(api?.logger ?? console, `[atlasdeck-bridge] ${msg}`);
      } catch {
        /* ignore */
      }
    };

    async function post(path, body, ms = timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { "x-openclaw-token": token } : {}) },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          log(`${path} → HTTP ${res.status}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        log(`${path} failed: ${err && err.message ? err.message : err}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    function eligible(ctx, text) {
      const kind = ctx?.inputProvenance?.kind;
      if (kind && kind !== "external_user") return false; // inter_session / internal_system
      if (ctx?.jobId) return false; // cron
      const info = sessionInfo(ctx);
      if (!info.senderId && !info.chatId) return false; // heartbeat / exec-event / cron
      if (skipAgents.has(info.agentId)) return false;
      if (!info.channel || !channels.has(String(info.channel).toLowerCase())) return false;
      if (!allowGroups && isGroupChat(ctx)) return false;
      if (owners.length && info.senderId && !owners.includes(String(info.senderId))) return false;
      if (text && SKIP_TEXT_RE.test(text)) return false;
      return Boolean(info.sessionKey);
    }

    if (injectOn) {
      api.on("before_prompt_build", async (event, ctx) => {
        try {
          const raw = lastUserText(event);
          // Already carries a memory block (e.g. injected upstream): don't double up.
          if (!raw || raw.includes("<atlas-memory>")) return undefined;
          const message = raw.trim();
          if (!eligible(ctx, message)) return undefined;
          const info = sessionInfo(ctx);
          const out = await post("/api/memory/turn-context", {
            message: message.slice(0, 4000),
            sessionKey: info.sessionKey,
            sessionId: info.sessionId,
            agentId: info.agentId,
            channel: info.channel,
            continuityState: event?.continuity?.state,
          });
          const block = out && typeof out.prependContext === "string" ? out.prependContext : "";
          return block ? { prependContext: block } : undefined;
        } catch (err) {
          log(`before_prompt_build error: ${err && err.message ? err.message : err}`);
          return undefined;
        }
      });
    }

    if (captureOn) {
      api.on("agent_end", async (event, ctx) => {
        try {
          const msgs = normalizeMessages(event?.messages);
          let lastUser = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "user") {
              lastUser = i;
              break;
            }
          }
          if (lastUser === -1) return;
          const user = stripMemoryBlock(msgs[lastUser].text);
          if (!user || !eligible(ctx, user)) return;
          const assistant = msgs
            .slice(lastUser + 1)
            .filter((m) => m.role === "assistant")
            .map((m) => m.text)
            .join("\n\n");
          const info = sessionInfo(ctx);
          void post(
            "/api/memory/turn-capture",
            {
              sessionKey: info.sessionKey,
              sessionId: info.sessionId,
              agentId: info.agentId,
              channel: info.channel,
              senderId: info.senderId,
              turnId: pick(ctx?.completedTurn?.entryId, ctx?.runId, event?.runId),
              success: event?.success !== false && !event?.error,
              user: user.slice(0, 20000),
              assistant: assistant.slice(0, 20000),
            },
            Math.max(timeoutMs, 5000),
          );
        } catch (err) {
          log(`agent_end error: ${err && err.message ? err.message : err}`);
        }
      });

      // On Telegram the reply is delivered through the `message` tool and is
      // absent from agent_end's snapshot; message_sent carries the text that
      // actually reached the user. Fires before agent_end — AtlasDeck pairs them.
      api.on("message_sent", async (event, ctx) => {
        try {
          if (event?.success === false || event?.error) return;
          const content = typeof event?.content === "string" ? event.content : textOf(event?.content ?? event?.text);
          const info = sessionInfo(ctx);
          if (!content || !info.sessionKey || skipAgents.has(info.agentId)) return;
          const channel = String(info.channel || (/:telegram:/.test(info.sessionKey) ? "telegram" : "")).toLowerCase();
          if (!channels.has(channel)) return;
          if (!allowGroups && isGroupChat(ctx)) return;
          void post("/api/memory/turn-reply", { sessionKey: info.sessionKey, content: content.slice(0, 20000) }, Math.max(timeoutMs, 5000));
        } catch (err) {
          log(`message_sent error: ${err && err.message ? err.message : err}`);
        }
      });

      api.on("session_end", async (event, ctx) => {
        try {
          const info = sessionInfo({ ...(ctx || {}), ...(event || {}) });
          if (!info.sessionKey || skipAgents.has(info.agentId)) return;
          void post("/api/memory/session-event", {
            sessionKey: info.sessionKey,
            sessionId: info.sessionId,
            agentId: info.agentId,
            reason: pick(event?.reason, ctx?.reason),
          });
        } catch {
          /* ignore */
        }
      });
    }

    log(
      `registered (baseUrl=${baseUrl}, channels=${[...channels].join(",")}, inject=${injectOn}, capture=${captureOn}, groups=${allowGroups}, owners=${owners.length})`,
    );
  },
});
