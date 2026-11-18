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
  if (reply) {
    appendMessage({
      thread_id: thread.id,
      role: "assistant",
      content: reply,
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
      },
    },
  });
  return { threadId: thread.id, stored: true };
}
