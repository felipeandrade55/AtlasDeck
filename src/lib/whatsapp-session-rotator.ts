/**
 * Rotates the active WhatsApp conversation session(s) so the Codex agent
 * starts the next turn with a fresh context window.
 *
 * Mirror of `telegram-session-rotator.ts` but scoped to sessions whose
 * head contains "whatsapp" (the OpenClaw session-ingest writes the
 * channel scope as part of the prelude, so a simple substring peek is
 * enough to discriminate).
 *
 * Why this exists separately from the Telegram rotator:
 *   `agent:main` services BOTH channels and each writes its own JSONL
 *   sessions in `~/.openclaw/agents/main/sessions/`. When the WhatsApp
 *   thread overflows, Codex emits `item/started` but never
 *   `item/completed` (observed 2026-05-31 — the smoking gun behind
 *   "📝 mas sem reply"). Rotating only the telegram session leaves the
 *   whatsapp one stuck. We need a channel-scoped rotator.
 *
 * Why we DON'T just generalize the existing rotator:
 *   The telegram-session-rotator is in production and works. Refactoring
 *   it to take a `channel` param risks breaking the working watchdog
 *   path. Duplication is the safe call until both rotators have proven
 *   themselves, at which point we can extract `session-rotator-core`.
 */
import { promises as fsp, statSync, existsSync } from "fs";
import path from "path";

import { readOpenClawConfig } from "./openclaw-config";
import { logActivity } from "./activities-db";

export interface RotateWhatsappInput {
  /** Agent id to inspect. Defaults to "main". */
  agentId?: string;
  /** When true, no disk mutations happen — return the plan. */
  dryRun?: boolean;
  /** Skip rotation if the candidate file was written to within this window. */
  inactivitySafetyMs?: number;
  /** Audit tag — "manual" (user clicked the button), "auto-watchdog"
   *  (scheduler tick), or "api" (some other caller). */
  triggeredBy?: "manual" | "auto-watchdog" | "api";
}

export interface RotateWhatsappResult {
  rotated: boolean;
  reason: string;
  /** Files we acted on (or would have). Multi-file because a single
   *  WhatsApp scope can produce both `<id>.jsonl` and
   *  `<id>.trajectory.jsonl` pairs that share state — we rotate both
   *  in one shot to keep them in sync. */
  files: Array<{ filePath: string; rotatedTo: string; sizeBytes: number }>;
  agentId: string;
}

export interface CleanupOldRotationsInput {
  /** Agent id to scan. Defaults to "main". */
  agentId?: string;
  /** Delete files older than this many days. Must be >= 1 to actually
   *  delete (0 returns the plan without touching anything). */
  olderThanDays: number;
  /** When true, list-only — no unlinks. */
  dryRun?: boolean;
  triggeredBy?: "manual" | "auto-watchdog" | "api";
}

export interface CleanupOldRotationsResult {
  scanned: number;
  deleted: Array<{ filePath: string; sizeBytes: number; ageDays: number }>;
  skipped: Array<{ filePath: string; sizeBytes: number; ageDays: number; reason: string }>;
  totalBytesFreed: number;
  agentId: string;
  dryRun: boolean;
}

const DEFAULT_INACTIVITY_MS = 5_000;
const SCAN_PEEK_BYTES = 32 * 1024;

interface SessionCandidate {
  filePath: string;
  sessionId: string;
  agentId: string;
  mtimeMs: number;
  sizeBytes: number;
}

async function peekIsWhatsappSession(filePath: string): Promise<boolean> {
  let fh: import("fs/promises").FileHandle | null = null;
  try {
    fh = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(SCAN_PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SCAN_PEEK_BYTES, 0);
    const head = buf.toString("utf8", 0, bytesRead);
    // OpenClaw session prelude embeds the channel scope. The string
    // "whatsapp" (case-insensitive) in the first 32KB is a reliable
    // marker — same peek the manual diagnosis on 2026-05-31 used and
    // it correctly picked the live whatsapp threads.
    return /whatsapp/i.test(head);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

async function findActiveWhatsappSessions(
  agentId: string,
): Promise<SessionCandidate[]> {
  const cfg = readOpenClawConfig();
  const sessionsDir = path.join(cfg.openclawDir, "agents", agentId, "sessions");
  if (!existsSync(sessionsDir)) return [];

  let entries: string[];
  try {
    entries = (await fsp.readdir(sessionsDir)).filter(
      (f) =>
        f.endsWith(".jsonl") &&
        // Already-rotated files keep `.reset.` in the name — skip so we
        // don't re-rotate artifacts and pile up `.reset.<ts1>.reset.<ts2>`.
        !f.includes(".reset.") &&
        // Codex writes per-session sidecar files. We only act on the
        // primary `.jsonl` (and its `.trajectory.jsonl` twin); the JSON
        // sidecars don't carry the conversation context.
        !f.endsWith(".trajectory-path.json") &&
        !f.endsWith(".codex-app-server.json"),
    );
  } catch {
    return [];
  }

  const candidates: SessionCandidate[] = [];
  for (const name of entries) {
    const full = path.join(sessionsDir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile() || s.size === 0) continue;
    if (!(await peekIsWhatsappSession(full))) continue;
    candidates.push({
      filePath: full,
      sessionId: name.replace(/\.jsonl$/, ""),
      agentId,
      mtimeMs: s.mtimeMs,
      sizeBytes: s.size,
    });
  }

  // Most recent first so the "active" session is at the top.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * Rotate WhatsApp session(s) for `agentId`. Acts on the most recently
 * modified `.jsonl` and its `.trajectory.jsonl` twin (when present) so
 * Codex's view and the trajectory log stay aligned. Idempotent against
 * rapid double-calls because the rename target is timestamped to ms.
 */
export async function rotateActiveWhatsappSession(
  input: RotateWhatsappInput = {},
): Promise<RotateWhatsappResult> {
  const agentId = input.agentId ?? "main";
  const inactivityMs = input.inactivitySafetyMs ?? DEFAULT_INACTIVITY_MS;
  const triggeredBy = input.triggeredBy ?? "manual";

  const all = await findActiveWhatsappSessions(agentId);
  if (all.length === 0) {
    return {
      rotated: false,
      reason: `Nenhuma sessão WhatsApp ativa encontrada pra agent "${agentId}".`,
      files: [],
      agentId,
    };
  }

  // Pick the most recent .jsonl as the anchor and rotate it together
  // with its .trajectory.jsonl twin (same base sessionId).
  const anchor = all[0];
  const twin = all.find(
    (c) => c.sessionId === `${anchor.sessionId}.trajectory` ||
           c.sessionId.replace(/\.trajectory$/, "") === anchor.sessionId.replace(/\.trajectory$/, ""),
  );
  // Build the targets set: anchor + twin (deduped).
  const targets = new Map<string, SessionCandidate>();
  targets.set(anchor.filePath, anchor);
  if (twin && twin.filePath !== anchor.filePath) {
    targets.set(twin.filePath, twin);
  }
  // Also pick up any other file sharing the same UUID prefix (Codex
  // sometimes writes additional .jsonl shards per topic).
  const baseUuid = anchor.sessionId.replace(/(\.trajectory|-topic-.*)$/, "");
  for (const c of all) {
    if (c.sessionId.startsWith(baseUuid)) targets.set(c.filePath, c);
  }

  const age = Date.now() - anchor.mtimeMs;
  if (age < inactivityMs) {
    return {
      rotated: false,
      reason: `Sessão WhatsApp foi modificada há ${age}ms — abaixo do safety window de ${inactivityMs}ms. Tenta de novo logo.`,
      files: [],
      agentId,
    };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");

  const rotated: RotateWhatsappResult["files"] = [];
  const planned: RotateWhatsappResult["files"] = [];
  for (const c of targets.values()) {
    const baseName = path.basename(c.filePath);
    const dirName = path.dirname(c.filePath);
    // Strip the .jsonl, append .reset.<ts>.jsonl
    const targetName = baseName.replace(/\.jsonl$/, `.reset.${ts}.jsonl`);
    const targetPath = path.join(dirName, targetName);
    planned.push({
      filePath: c.filePath,
      rotatedTo: targetPath,
      sizeBytes: c.sizeBytes,
    });
    if (input.dryRun) continue;
    try {
      await fsp.rename(c.filePath, targetPath);
      rotated.push({
        filePath: c.filePath,
        rotatedTo: targetPath,
        sizeBytes: c.sizeBytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity(
        "command",
        `Falha ao rotacionar sessão WhatsApp do agent ${agentId}`,
        "error",
        {
          metadata: {
            action: "whatsapp-session-rotate",
            triggeredBy,
            filePath: c.filePath,
            targetPath,
            error: msg,
          },
        },
      );
    }
  }

  if (input.dryRun) {
    return {
      rotated: false,
      reason: `dryRun=true — ${planned.length} arquivo(s) seriam rotacionados.`,
      files: planned,
      agentId,
    };
  }

  if (rotated.length === 0) {
    return {
      rotated: false,
      reason: "Tentei rotacionar mas todos os renames falharam (veja activities).",
      files: [],
      agentId,
    };
  }

  const totalBytes = rotated.reduce((s, f) => s + f.sizeBytes, 0);
  logActivity(
    "command",
    `Sessão WhatsApp rotacionada (${rotated.length} arquivo(s), ${(totalBytes / 1024 / 1024).toFixed(2)}MB, trigger=${triggeredBy})`,
    "success",
    {
      metadata: {
        action: "whatsapp-session-rotate",
        triggeredBy,
        agentId,
        files: rotated.map((f) => ({
          from: f.filePath,
          to: f.rotatedTo,
          sizeBytes: f.sizeBytes,
        })),
        totalBytes,
      },
    },
  );

  return {
    rotated: true,
    reason: `${rotated.length} arquivo(s) renomeados. Próxima mensagem do WhatsApp cria um JSONL novo e o agente começa com contexto vazio.`,
    files: rotated,
    agentId,
  };
}

/**
 * Delete `.reset.<ts>.jsonl` artifacts older than `olderThanDays` from
 * the agent's sessions directory. Targets ONLY rotated artifacts —
 * never touches active session files (those don't have `.reset.` in
 * the name).
 *
 * Safety:
 *   - Hard filter: filename must contain `.reset.` AND end with `.jsonl`
 *     (or `.json` for the trajectory sidecar). Prevents the world's
 *     dumbest typo from nuking active sessions.
 *   - `olderThanDays < 1` → dryRun forced. Caller can't accidentally
 *     pass `0` and wipe today's rotations.
 *   - Uses `fs.statSync` mtime (NOT the timestamp in the filename) so
 *     even if someone hand-renames a file, the age check still holds.
 */
export async function cleanupOldWhatsappRotations(
  input: CleanupOldRotationsInput,
): Promise<CleanupOldRotationsResult> {
  const agentId = input.agentId ?? "main";
  const triggeredBy = input.triggeredBy ?? "manual";
  // 0 or negative → treat as dryRun so a misconfigured cleanupDays
  // can never delete fresh artifacts. The watchdog disables itself
  // when cleanupDays=0 (see whatsapp-rotation-watchdog), so this is
  // a defense-in-depth check.
  const dryRun = input.dryRun || input.olderThanDays < 1;
  const olderThanDays = Math.max(1, input.olderThanDays);

  const cfg = readOpenClawConfig();
  const sessionsDir = path.join(cfg.openclawDir, "agents", agentId, "sessions");

  const result: CleanupOldRotationsResult = {
    scanned: 0,
    deleted: [],
    skipped: [],
    totalBytesFreed: 0,
    agentId,
    dryRun,
  };

  if (!existsSync(sessionsDir)) return result;

  let entries: string[];
  try {
    entries = await fsp.readdir(sessionsDir);
  } catch {
    return result;
  }

  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  for (const name of entries) {
    // Hard filter — only touch `.reset.` artifacts. The match must be
    // in the middle of the name, not at the start, to avoid edge cases.
    if (!name.includes(".reset.")) continue;
    if (!(name.endsWith(".jsonl") || name.endsWith(".json"))) continue;

    const full = path.join(sessionsDir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    result.scanned += 1;

    const ageMs = Date.now() - s.mtimeMs;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    if (s.mtimeMs > cutoffMs) {
      result.skipped.push({
        filePath: full,
        sizeBytes: s.size,
        ageDays,
        reason: `younger than ${olderThanDays}d`,
      });
      continue;
    }

    if (dryRun) {
      result.deleted.push({ filePath: full, sizeBytes: s.size, ageDays });
      result.totalBytesFreed += s.size;
      continue;
    }

    try {
      await fsp.unlink(full);
      result.deleted.push({ filePath: full, sizeBytes: s.size, ageDays });
      result.totalBytesFreed += s.size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.skipped.push({
        filePath: full,
        sizeBytes: s.size,
        ageDays,
        reason: `unlink failed: ${msg}`,
      });
    }
  }

  if (!dryRun && result.deleted.length > 0) {
    const mb = (result.totalBytesFreed / 1024 / 1024).toFixed(2);
    logActivity(
      "command",
      `Limpeza de rotações WhatsApp: ${result.deleted.length} arquivo(s) apagados (${mb}MB liberados, trigger=${triggeredBy})`,
      "success",
      {
        metadata: {
          action: "whatsapp-rotation-cleanup",
          triggeredBy,
          agentId,
          olderThanDays,
          filesDeleted: result.deleted.length,
          bytesFreed: result.totalBytesFreed,
        },
      },
    );
  }

  return result;
}

