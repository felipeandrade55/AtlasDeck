/**
 * Rotates the active Telegram conversation session so the Codex agent
 * starts the next turn with a fresh context window.
 *
 * Why a rotator instead of "just restart the gateway":
 *   The Telegram conversation state for sessionKey
 *   `agent:main:telegram:direct:<chatId>` is persisted as a JSONL file
 *   under `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`.
 *   Restarting the gateway preserves that file, so the same long
 *   conversation gets re-attached on boot and overflows again on the
 *   very next message. The user has to manually start a new chat,
 *   which is annoying for power users and a non-starter for non-tech
 *   users.
 *
 * What rotation does:
 *   - Finds the JSONL file that's currently bound to the user's
 *     Telegram session (heuristic: most recently modified file under
 *     `~/.openclaw/agents/<agent>/sessions/` matching telegram scope).
 *   - Renames it to `<id>.reset.<ts>.jsonl` — the same naming convention
 *     `session-ingest.ts` already recognises and filters out (so the
 *     rotated file lingers as an artifact, not as an active session).
 *   - The next user message lands on a freshly-created session file.
 *
 * Safety:
 *   - Skip files that were written to in the last `inactivitySafetyMs`
 *     (default 5s) to avoid renaming under the gateway's nose mid-write.
 *   - dryRun=true returns the plan without touching disk — used by the
 *     diagnose endpoint to preview "what would the reset button do".
 *   - Logs to activities-db so the user can see exactly when AtlasDeck
 *     rotated a session and why.
 */
import { promises as fsp, statSync, existsSync } from "fs";
import path from "path";

import { readOpenClawConfig } from "./openclaw-config";
import { logActivity } from "./activities-db";

export interface RotateSessionInput {
  /** Agent id to inspect. Defaults to "main". */
  agentId?: string;
  /** Chat id we expect to find inside the JSONL (filters out unrelated sessions). */
  chatId?: string | number;
  /** Channel scope (`telegram` | `direct`). Defaults to telegram-or-direct. */
  scope?: "telegram" | "direct" | "any";
  /** When true, no disk mutations happen and we return what *would* be done. */
  dryRun?: boolean;
  /** Skip rotation if the candidate file was written to within this window. */
  inactivitySafetyMs?: number;
  /** Tag for the activity log so the source is auditable. */
  triggeredBy?: "manual" | "auto-watchdog" | "api";
}

export interface RotateSessionResult {
  rotated: boolean;
  reason: string;
  /** Path of the JSONL we acted on (or would have). */
  filePath?: string;
  /** New name after rename. */
  rotatedTo?: string;
  agentId: string;
  /** When set, the candidate file is too fresh to rotate — try again in N ms. */
  retryAfterMs?: number;
  /** Heuristics that led us to pick this file — useful for debugging. */
  matchedBy?: string[];
}

const DEFAULT_INACTIVITY_MS = 5_000;
const SCAN_PEEK_BYTES = 32 * 1024;

interface SessionCandidate {
  filePath: string;
  sessionId: string;
  agentId: string;
  mtimeMs: number;
  sizeBytes: number;
  matchedBy: string[];
}

/**
 * Inspect the first ~32KB of a JSONL session to see if it belongs to
 * the Telegram chat we care about. We peek instead of full-read because
 * a busy session can grow into the megabytes and we only need to see
 * the scope/chatId in the prelude.
 */
async function peekMatchesTelegramSession(
  filePath: string,
  chatId: string | null,
  scope: RotateSessionInput["scope"],
): Promise<{ matches: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  let fh: import("fs/promises").FileHandle | null = null;
  try {
    fh = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(SCAN_PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SCAN_PEEK_BYTES, 0);
    const head = buf.toString("utf8", 0, bytesRead);

    const wantTelegram = scope === undefined || scope === "any" || scope === "telegram";
    const wantDirect = scope === undefined || scope === "any" || scope === "direct";

    if (wantTelegram && /telegram/i.test(head)) reasons.push("scope:telegram");
    if (wantDirect && /"direct"/i.test(head)) reasons.push("scope:direct");
    if (chatId && head.includes(String(chatId))) reasons.push(`chat:${chatId}`);

    // No filtering signal at all → accept if scope is "any" so a stale
    // empty file at the head of the list still gets considered.
    if (!chatId && (scope === undefined || scope === "any")) {
      return { matches: true, reasons: reasons.length > 0 ? reasons : ["scope:any"] };
    }

    return { matches: reasons.length > 0, reasons };
  } catch {
    return { matches: false, reasons: [] };
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

async function findActiveTelegramSession(
  agentId: string,
  chatId: string | null,
  scope: RotateSessionInput["scope"],
): Promise<SessionCandidate | null> {
  const cfg = readOpenClawConfig();
  const sessionsDir = path.join(cfg.openclawDir, "agents", agentId, "sessions");
  if (!existsSync(sessionsDir)) return null;

  let entries: string[];
  try {
    entries = (await fsp.readdir(sessionsDir)).filter(
      (f) =>
        f.endsWith(".jsonl") &&
        !f.includes(".reset.") &&
        !f.endsWith(".trajectory.jsonl") &&
        !f.endsWith(".trajectory-path.json") &&
        !f.endsWith(".codex-app-server.json"),
    );
  } catch {
    return null;
  }

  type Indexed = SessionCandidate & { matched: boolean };
  const indexed: Indexed[] = [];
  for (const name of entries) {
    const full = path.join(sessionsDir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile() || s.size === 0) continue;
    const peek = await peekMatchesTelegramSession(full, chatId, scope);
    indexed.push({
      filePath: full,
      sessionId: name.replace(/\.jsonl$/, ""),
      agentId,
      mtimeMs: s.mtimeMs,
      sizeBytes: s.size,
      matched: peek.matches,
      matchedBy: peek.reasons,
    });
  }

  if (indexed.length === 0) return null;

  // Prefer matched candidates; among those, pick the most recently
  // touched. If nothing matched (e.g. chatId filter excluded everything),
  // fall back to the latest file with no match reasons recorded — the
  // caller can decide whether to trust that.
  indexed.sort((a, b) => Number(b.matched) - Number(a.matched) || b.mtimeMs - a.mtimeMs);
  const top = indexed[0];
  if (!top.matched && chatId) return null;
  return top;
}

/**
 * Rotate the active Telegram session for `agentId`. Idempotent against
 * rapid double-calls because the rename target is timestamped to ms.
 */
export async function rotateActiveTelegramSession(
  input: RotateSessionInput = {},
): Promise<RotateSessionResult> {
  const agentId = input.agentId ?? "main";
  const scope = input.scope ?? "any";
  const chatId = input.chatId !== undefined ? String(input.chatId) : null;
  const inactivityMs = input.inactivitySafetyMs ?? DEFAULT_INACTIVITY_MS;
  const triggeredBy = input.triggeredBy ?? "manual";

  const candidate = await findActiveTelegramSession(agentId, chatId, scope);
  if (!candidate) {
    return {
      rotated: false,
      reason:
        chatId !== null
          ? `Nenhuma sessão ativa encontrada pra chat ${chatId} no agent "${agentId}".`
          : `Nenhuma sessão ativa encontrada pra agent "${agentId}".`,
      agentId,
    };
  }

  const age = Date.now() - candidate.mtimeMs;
  if (age < inactivityMs) {
    return {
      rotated: false,
      reason: `Arquivo foi modificado há ${age}ms — abaixo do safety window de ${inactivityMs}ms. Tenta de novo logo.`,
      filePath: candidate.filePath,
      agentId,
      retryAfterMs: inactivityMs - age,
      matchedBy: candidate.matchedBy,
    };
  }

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  const targetName = `${candidate.sessionId}.reset.${ts}.jsonl`;
  const targetPath = path.join(path.dirname(candidate.filePath), targetName);

  if (input.dryRun) {
    return {
      rotated: false,
      reason: "dryRun=true — plano calculado mas nada foi renomeado.",
      filePath: candidate.filePath,
      rotatedTo: targetPath,
      agentId,
      matchedBy: candidate.matchedBy,
    };
  }

  try {
    await fsp.rename(candidate.filePath, targetPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity(
      "command",
      `Falha ao rotacionar sessão Telegram do agent ${agentId}`,
      "error",
      {
        metadata: {
          action: "telegram-session-rotate",
          triggeredBy,
          filePath: candidate.filePath,
          targetPath,
          error: msg,
        },
      },
    );
    return {
      rotated: false,
      reason: `Rename falhou: ${msg}`,
      filePath: candidate.filePath,
      agentId,
      matchedBy: candidate.matchedBy,
    };
  }

  logActivity(
    "command",
    `Sessão Telegram rotacionada (agent=${agentId}, trigger=${triggeredBy})`,
    "success",
    {
      metadata: {
        action: "telegram-session-rotate",
        triggeredBy,
        filePath: candidate.filePath,
        rotatedTo: targetPath,
        sizeBytes: candidate.sizeBytes,
        matchedBy: candidate.matchedBy,
      },
    },
  );

  return {
    rotated: true,
    reason:
      "Sessão renomeada — próxima mensagem do Telegram cria um arquivo novo e o agente começa com contexto vazio.",
    filePath: candidate.filePath,
    rotatedTo: targetPath,
    agentId,
    matchedBy: candidate.matchedBy,
  };
}
