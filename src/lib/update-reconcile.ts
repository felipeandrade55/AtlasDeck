import fs from "fs";
import {
  PHASE_LABELS,
  UpdateLiveStatus,
  UpdatePhase,
  liveLogPath,
  phaseEventsPath,
  readLiveStatus,
  updateHistoryEntry,
  writeLiveStatus,
} from "./update";
import { notifyUpdateResult } from "./update-notifier";

interface PhaseEventLine {
  phase?: string;
  status?: "running" | "ok" | "fail" | "skip";
  ts?: string;
  durationSec?: number;
  error?: string;
  heartbeat?: string;
}

export interface ReconcileResult {
  liveStatus: UpdateLiveStatus | null;
  newPhaseEvents: PhaseEventLine[];
  newLogLines: { line: string; timestamp: string }[];
  newPhaseOffset: number;
  newLogOffset: number;
  /** True if this call caused a transition into a terminal state. */
  justCompleted: boolean;
}

function tailFromOffset(filePath: string, offset: number): { content: string; newOffset: number } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return { content: "", newOffset: offset };

    const fd = fs.openSync(filePath, "r");
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      return { content: buffer.toString("utf-8"), newOffset: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { content: "", newOffset: offset };
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Lê novos eventos de phase do arquivo phase-events.log e novas linhas do log file.
 * Atualiza o live-status.json e o history conforme necessário.
 * Retorna os eventos novos para que o stream possa emiti-los via SSE.
 */
export async function reconcile(
  phaseOffset: number,
  logOffset: number
): Promise<ReconcileResult> {
  const currentLive = readLiveStatus();

  if (!currentLive) {
    return {
      liveStatus: null,
      newPhaseEvents: [],
      newLogLines: [],
      newPhaseOffset: phaseOffset,
      newLogOffset: logOffset,
      justCompleted: false,
    };
  }

  // Phase events
  const phaseRead = tailFromOffset(phaseEventsPath(), phaseOffset);
  const phaseLines = phaseRead.content.split("\n").filter((l) => l.trim().length > 0);
  const newPhaseEvents: PhaseEventLine[] = [];
  for (const line of phaseLines) {
    try {
      const evt = JSON.parse(line) as PhaseEventLine;
      newPhaseEvents.push(evt);
    } catch {
      // skip malformed
    }
  }

  // Log lines
  const logRead = tailFromOffset(liveLogPath(), logOffset);
  const newLogLines: { line: string; timestamp: string }[] = [];
  const rawLogLines = logRead.content.split("\n");
  // Don't emit final empty line from split
  for (let i = 0; i < rawLogLines.length; i++) {
    const raw = rawLogLines[i];
    // If the file does not end with a newline, the last piece is incomplete;
    // we still emit it because PM2 might restart and we want it visible.
    if (raw.length === 0 && i === rawLogLines.length - 1) continue;
    const cleaned = stripAnsi(raw).trimEnd();
    if (!cleaned) continue;
    newLogLines.push({ line: cleaned, timestamp: new Date().toISOString() });
  }

  // Apply phase events to live status
  const updatedLive: UpdateLiveStatus = { ...currentLive, phases: [...currentLive.phases] };
  const wasRunning = currentLive.status === "running";
  let justCompleted = false;

  for (const evt of newPhaseEvents) {
    if (evt.heartbeat) {
      updatedLive.lastHeartbeat = evt.heartbeat;
      continue;
    }
    if (!evt.phase || !evt.status) continue;

    // Use phase event timestamp as latest heartbeat too
    if (evt.ts) updatedLive.lastHeartbeat = evt.ts;

    if (evt.phase === "done") {
      updatedLive.status = evt.status === "ok" ? "complete" : "error";
      updatedLive.completedAt = evt.ts || new Date().toISOString();
      if (evt.status === "fail") {
        updatedLive.error = evt.error || "Update falhou";
      }
      justCompleted = true;
      continue;
    }

    if (evt.phase === "start") continue;

    // Find or add the phase in the list
    const idx = updatedLive.phases.findIndex((p) => p.name === evt.phase);
    const newPhase: UpdatePhase = {
      name: evt.phase,
      status: evt.status,
      durationSec: evt.durationSec,
      error: evt.error,
    };
    if (evt.status === "running") {
      newPhase.startedAt = evt.ts;
      updatedLive.currentPhase = evt.phase;
    }
    if (evt.status === "ok" || evt.status === "fail" || evt.status === "skip") {
      newPhase.completedAt = evt.ts;
    }

    if (idx >= 0) {
      updatedLive.phases[idx] = { ...updatedLive.phases[idx], ...newPhase };
    } else {
      updatedLive.phases.push(newPhase);
    }

    if (evt.status === "fail") {
      updatedLive.status = "error";
      updatedLive.error = evt.error || `Falha na fase ${PHASE_LABELS[evt.phase] || evt.phase}`;
      // Don't justCompleted until we see "done" — keep watching
    }
  }

  // NB: we deliberately do NOT bump lastHeartbeat just because we read new log
  // lines. On a fresh SSE/page connection the offset starts at 0, so the whole
  // log is re-read and counted as "new" — stamping `now` here made every page
  // refresh reset the dead-man timer, so a deploy.sh that died mid-phase looked
  // alive forever and never auto-reconciled. Liveness now comes only from real
  // signals: explicit heartbeat events (their own ts, handled above), phase
  // event timestamps, and the artifact file mtimes checked in getActiveUpdate.

  // Persist if anything changed
  const changed =
    newPhaseEvents.length > 0 ||
    newLogLines.length > 0 ||
    updatedLive.lastHeartbeat !== currentLive.lastHeartbeat;
  if (changed) {
    writeLiveStatus(updatedLive);
  }

  // If we just completed, sync history and emit notification — ONLY if previous
  // state was "running" (idempotent: subsequent reconciles won't re-fire notifications).
  if (justCompleted && wasRunning) {
    const completedAt = updatedLive.completedAt || new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(updatedLive.startedAt).getTime();

    try {
      // Read tail of log for the history entry
      const fullLog = (() => {
        try {
          return fs.readFileSync(liveLogPath(), "utf-8");
        } catch {
          return "";
        }
      })();
      updateHistoryEntry(updatedLive.historyId, {
        status: updatedLive.status === "complete" ? "success" : "error",
        completedAt,
        durationMs,
        phases: updatedLive.phases,
        logs: fullLog.slice(-50_000),
        error: updatedLive.error,
      });
    } catch (err) {
      console.warn("[reconcile] failed to update history:", err);
    }

    // Fire notification on bell — agora com briefing detalhado.
    void notifyUpdateResult(
      updatedLive.status === "complete",
      updatedLive.fromSha,
      updatedLive.toSha,
      {
        durationMs,
        errorMsg: updatedLive.error,
        origin: updatedLive.origin || "manual",
        phases: updatedLive.phases,
      }
    );

    // Activity log
    try {
      const { logActivity } = await import("./activities-db");
      const ok = updatedLive.status === "complete";
      const desc = ok
        ? `Update concluído: ${updatedLive.fromSha} → ${updatedLive.toSha}`
        : `Update falhou: ${updatedLive.error || "erro desconhecido"}`;
      logActivity("update", desc, ok ? "success" : "error", {
        duration_ms: durationMs,
        metadata: {
          fromSha: updatedLive.fromSha,
          toSha: updatedLive.toSha,
          historyId: updatedLive.historyId,
        },
      });
    } catch {}
  }

  return {
    liveStatus: updatedLive,
    newPhaseEvents,
    newLogLines,
    newPhaseOffset: phaseRead.newOffset,
    newLogOffset: logRead.newOffset,
    justCompleted,
  };
}
