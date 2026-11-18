/**
 * Store turns captured by the gateway bridge plugin (Telegram etc.) in
 * chats.db — the canonical transcript store the memory extractor reads.
 *
 * One thread per gateway sessionKey (source "telegram", source_session_id
 * = sessionKey), so a conversation stays one thread across gateway
 * session resets; the transcript id is kept in metadata.
 *
 * When the plugin is active it supersedes the JSONL importer as the
 * memory feed (see memory-extractor: openclaw_import threads are skipped
 * while the plugin is alive), so the same turn is never learned twice.
 */
import {
  appendMessage,
  createThread,
  getThreadBySource,
  updateThread,
} from "@/lib/chat-db";
import { cleanUserText } from "@/lib/memory-extractor";
import { markBridgeSeen } from "@/lib/bridge-status";

export { markBridgeSeen };

export interface CapturedTurn {
  sessionKey: string;
  sessionId?: string | null;
  agentId?: string | null;
  channel?: string | null;
  senderId?: string | null;
  turnId?: string | null;
  success?: boolean;
  user: string;
  assistant?: string | null;
}

export interface IngestResult {
  threadId: string;
  stored: boolean;
  reason?: string;
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "Conversa";
}

// ─── Delivered replies (message_sent) ─────────────────────────────────
// On Telegram the Codex harness delivers the reply through the `message`
// tool, so agent_end's message snapshot has the user turn but no assistant
// text. The plugin forwards `message_sent` (the text actually delivered),
// which arrives BEFORE agent_end: we buffer it per conversation and attach
// it when the turn is captured; replies arriving after the capture are
// appended directly while the turn's reply window is open.

const REPLY_BUFFER_MS = 10 * 60_000;
const REPLY_WINDOW_MS = 3 * 60_000;
const pendingReplies = new Map<string, Array<{ text: string; at: number }>>();

function takePendingReplies(sessionKey: string): string[] {
  const list = (pendingReplies.get(sessionKey) ?? []).filter((r) => Date.now() - r.at < REPLY_BUFFER_MS);
  pendingReplies.delete(sessionKey);
  return list.map((r) => r.text);
}

export function ingestDeliveredReply(input: { sessionKey: string; content: string }): {
  status: "appended" | "buffered" | "ignored";
  threadId?: string;
} {
  markBridgeSeen();
  const text = (input.content || "").trim();
  if (!text) return { status: "ignored" };
  const thread = getThreadBySource("telegram", input.sessionKey);
  const bridge = (thread?.metadata?.bridge ?? {}) as { replyWindowUntil?: number; replySource?: string };
  if (thread && (bridge.replyWindowUntil ?? 0) > Date.now()) {
    // agent_end already carried the reply text → this is the same reply.
    if (bridge.replySource === "agent_end") return { status: "ignored", threadId: thread.id };
    appendMessage({ thread_id: thread.id, role: "assistant", content: text, status: "complete" });
    return { status: "appended", threadId: thread.id };
  }
  const list = pendingReplies.get(input.sessionKey) ?? [];
  list.push({ text, at: Date.now() });
  pendingReplies.set(input.sessionKey, list.slice(-10));
  return { status: "buffered" };
}

export function ingestCapturedTurn(turn: CapturedTurn): IngestResult {
  markBridgeSeen();
  const user = cleanUserText(turn.user || "");
  const agentId = turn.agentId || "main";

  let thread = getThreadBySource("telegram", turn.sessionKey);
  if (!thread) {
    thread = createThread({
      agent_id: agentId,
      source: "telegram",
      source_session_id: turn.sessionKey,
      title: titleFrom(user),
      metadata: { bridge: { channel: turn.channel ?? null, sessionId: turn.sessionId ?? null, turnIds: [] } },
    });
  }

  const meta = (thread.metadata?.bridge as { turnIds?: string[]; sessionId?: string | null } | undefined) ?? {};
  const seen = Array.isArray(meta.turnIds) ? meta.turnIds : [];
  if (turn.turnId && seen.includes(turn.turnId)) {
    return { threadId: thread.id, stored: false, reason: "duplicate turn" };
  }
  if (!user) return { threadId: thread.id, stored: false, reason: "empty user text" };

  appendMessage({ thread_id: thread.id, role: "user", content: user, status: "complete" });
  const reply = (turn.assistant || "").trim();
  const delivered = reply ? [] : takePendingReplies(turn.sessionKey);
  if (reply) pendingReplies.delete(turn.sessionKey);
  for (const text of reply ? [reply] : delivered) {
    appendMessage({
      thread_id: thread.id,
      role: "assistant",
      content: text,
      status: turn.success === false ? "error" : "complete",
    });
  }

  updateThread(thread.id, {
    metadata: {
      ...thread.metadata,
      bridge: {
        ...meta,
        channel: turn.channel ?? null,
        sessionId: turn.sessionId ?? meta.sessionId ?? null,
        turnIds: turn.turnId ? [...seen, turn.turnId].slice(-30) : seen,
        replyWindowUntil: Date.now() + REPLY_WINDOW_MS,
        replySource: reply ? "agent_end" : "message_sent",
      },
    },
  });
  return { threadId: thread.id, stored: true };
}
