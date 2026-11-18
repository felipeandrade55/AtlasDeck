/**
 * Per-turn memory context.
 *
 * Instead of hoping the agent decides to call `memory_search`, AtlasDeck
 * looks up what is relevant to the message being answered and hands it
 * over with the message, inside `<atlas-memory>…</atlas-memory>`:
 *
 *   - memories relevant to this message (hybrid search, relevance-gated —
 *     nothing is injected when nothing is relevant);
 *   - on the first turn of a new session (gateway reset, /new, watchdog
 *     rotation, new web thread): short summaries of the latest
 *     conversations, so the bot picks up where it left off.
 *
 * Used by the web chat route directly and by the gateway bridge plugin
 * (Telegram/WhatsApp) through POST /api/memory/turn-context.
 *
 * The block is stripped from transcripts before extraction (see
 * memory-extractor.cleanUserText) so we never learn from our own output.
 */
import {
  listRecentSessionSummaries,
  logRecall,
  recordAccess,
  touchTurnSession,
  type MemoryRow,
} from "@/lib/memory-db";
import { searchHybrid, workspaceForAgent } from "@/lib/memory-service";
import { sqliteTimeToMs } from "@/lib/chat-db";
import { buildWorkContext } from "@/lib/reuse-context";
import { getPreferenceList } from "@/lib/preference-model";

export const TURN_CONTEXT_OPEN = "<atlas-memory>";
export const TURN_CONTEXT_CLOSE = "</atlas-memory>";

const MAX_BLOCK_CHARS = 3_000;
const MEMORY_CONTENT_CHARS = 320;

export interface TurnContextInput {
  message: string;
  agentId?: string | null;
  /** Stable conversation key (gateway sessionKey, or `web:<threadId>`). */
  sessionKey: string;
  /** Transcript id; a change for the same key means a new session. */
  sessionId?: string | null;
  channel?: string | null;
  /** chats.db thread to exclude from "recent conversations". */
  threadId?: string | null;
  /** Caller already knows this is a fresh session. */
  isNewSession?: boolean;
}

export interface TurnContextResult {
  block: string;
  memoryIds: string[];
  isNewSession: boolean;
  chars: number;
  tookMs: number;
}

/** Messages that carry no topic — searching memories for them is noise. */
const TRIVIAL_RE =
  /^(ok|okay|blz|beleza|valeu|obrigad[oa]|vlw|sim|n[aã]o|isso|pode|show|top|massa|perfeito|certo|entendi|bom dia|boa tarde|boa noite|oi|ol[aá]|e a[ií]|tudo bem\??)[!. ]*$/i;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatDate(sqliteTime: string): string {
  const ms = sqliteTimeToMs(sqliteTime);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function renderMemory(m: MemoryRow): string {
  const body = clip(m.content, MEMORY_CONTENT_CHARS);
  return body.toLowerCase().startsWith(m.title.toLowerCase().slice(0, 30))
    ? `- ${body}`
    : `- **${m.title}**: ${body}`;
}

export async function buildTurnContext(input: TurnContextInput): Promise<TurnContextResult> {
  const started = Date.now();
  const agentId = input.agentId || "main";
  const message = (input.message || "").trim();

  const session = touchTurnSession({
    sessionKey: input.sessionKey,
    sessionId: input.sessionId ?? null,
    agentId,
    channel: input.channel ?? null,
  });
  const isNewSession = input.isNewSession ?? session.isNewSession;

  const sections: string[] = [];
  let memories: MemoryRow[] = [];
  const workspace = workspaceForAgent(agentId);

  // Clients, brand kits and "reuse what we did for X?" precedents first —
  // they are the most actionable part of the block.
  if (message && !TRIVIAL_RE.test(message)) {
    try {
      sections.push(...buildWorkContext(message, workspace, input.sessionKey).sections);
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") console.warn("[turn-context] work context failed:", err);
    }
  }

  if (message && !TRIVIAL_RE.test(message)) {
    const hits = await searchHybrid(message.slice(0, 1500), { workspace, k: 6 });
    memories = hits.map((h) => h.memory);
    if (memories.length) {
      sections.push(
        `O que você já sabe e é relevante para esta mensagem (use naturalmente; não diga que "consultou a memória"):\n${memories.map(renderMemory).join("\n")}`,
      );
    }
  }

  if (isNewSession) {
    // Standing preferences, so they hold even where bootstrap files
    // (USER.md) aren't re-read every turn.
    const prefs = getPreferenceList(agentId, 6);
    if (prefs.length) {
      sections.push(`Como o dono gosta que você trabalhe:\n${prefs.map((p) => `- ${clip(p, 200)}`).join("\n")}`);
    }
    const recent = listRecentSessionSummaries({
      agentId,
      excludeThreadId: input.threadId ?? null,
      sinceDays: 7,
      limit: 4,
    });
    if (recent.length) {
      sections.push(
        `Conversas recentes (para dar continuidade, se fizer sentido):\n${recent
          .map((r) => `- ${formatDate(r.created_at)}: ${clip(r.summary, 220)}`)
          .join("\n")}`,
      );
    }
  }

  if (sections.length === 0) {
    return { block: "", memoryIds: [], isNewSession, chars: 0, tookMs: Date.now() - started };
  }

  let inner = sections.join("\n\n");
  if (inner.length > MAX_BLOCK_CHARS) inner = `${inner.slice(0, MAX_BLOCK_CHARS - 1)}…`;
  const block = `${TURN_CONTEXT_OPEN}\n${inner}\n${TURN_CONTEXT_CLOSE}`;

  const ids = memories.map((m) => m.id);
  for (const id of ids) recordAccess(id);
  logRecall(input.sessionKey, "memory", ids);

  return { block, memoryIds: ids, isNewSession, chars: block.length, tookMs: Date.now() - started };
}

/** Same as buildTurnContext but never throws and never takes longer than `budgetMs`. */
export async function buildTurnContextSafe(
  input: TurnContextInput,
  budgetMs = 1_500,
): Promise<TurnContextResult | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      buildTurnContext(input),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") console.warn("[turn-context] failed:", err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
