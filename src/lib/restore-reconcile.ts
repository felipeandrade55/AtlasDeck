import fs from "fs";
import {
  RESTORE_PHASE_LABELS,
  RestoreLiveStatus,
  RestorePhase,
  readRestoreLiveStatus,
  restoreLogPath,
  restorePhaseEventsPath,
  writeRestoreLiveStatus,
} from "./restore";
import { notifyRestoreResult } from "./restore-notifier";

interface PhaseEventLine {
  phase?: string;
  status?: "running" | "ok" | "fail" | "skip";
  ts?: string;
  durationSec?: number;
  error?: string;
  heartbeat?: string;
}

export interface ReconcileResult {
  liveStatus: RestoreLiveStatus | null;
  newPhaseEvents: PhaseEventLine[];
  newLogLines: { line: string; timestamp: string }[];
  newPhaseOffset: number;
  newLogOffset: number;
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
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function reconcile(
  phaseOffset: number,
  logOffset: number
): Promise<ReconcileResult> {
  const currentLive = readRestoreLiveStatus();

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

  const phaseRead = tailFromOffset(restorePhaseEventsPath(), phaseOffset);
  const phaseLines = phaseRead.content.split("\n").filter((l) => l.trim().length > 0);
  const newPhaseEvents: PhaseEventLine[] = [];
  for (const line of phaseLines) {
    try {
      newPhaseEvents.push(JSON.parse(line) as PhaseEventLine);
    } catch {
      // skip malformed
    }
  }

  const logRead = tailFromOffset(restoreLogPath(), logOffset);
  const newLogLines: { line: string; timestamp: string }[] = [];
  const rawLogLines = logRead.content.split("\n");
  for (let i = 0; i < rawLogLines.length; i++) {
    const raw = rawLogLines[i];
    if (raw.length === 0 && i === rawLogLines.length - 1) continue;
    const cleaned = stripAnsi(raw).trimEnd();
    if (!cleaned) continue;
    newLogLines.push({ line: cleaned, timestamp: new Date().toISOString() });
  }

  const updatedLive: RestoreLiveStatus = { ...currentLive, phases: [...currentLive.phases] };
  const wasRunning = currentLive.status === "running";
  let justCompleted = false;

  for (const evt of newPhaseEvents) {
    if (evt.heartbeat) {
      updatedLive.lastHeartbeat = evt.heartbeat;
      continue;
    }
    if (!evt.phase || !evt.status) continue;

    if (evt.ts) updatedLive.lastHeartbeat = evt.ts;

    if (evt.phase === "done") {
      updatedLive.status = evt.status === "ok" ? "complete" : "error";
      updatedLive.completedAt = evt.ts || new Date().toISOString();
      if (evt.status === "fail") {
        updatedLive.error = evt.error || "Restore falhou";
      }
      justCompleted = true;
      continue;
    }

    if (evt.phase === "start") continue;

    const idx = updatedLive.phases.findIndex((p) => p.name === evt.phase);
    const newPhase: RestorePhase = {
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
      updatedLive.error =
        evt.error || `Falha na fase ${RESTORE_PHASE_LABELS[evt.phase] || evt.phase}`;
    }

    // Detecta rollback bem-sucedido: phase=rollback, status=ok
    if (evt.phase === "rollback" && evt.status === "ok") {
      updatedLive.rolledBack = true;
    }
  }

  if (newLogLines.length > 0) {
    updatedLive.lastHeartbeat = new Date().toISOString();
  }

  const changed =
    newPhaseEvents.length > 0 ||
    newLogLines.length > 0 ||
    updatedLive.lastHeartbeat !== currentLive.lastHeartbeat;
  if (changed) {
    writeRestoreLiveStatus(updatedLive);
  }

  if (justCompleted && wasRunning) {
    const completedAt = updatedLive.completedAt || new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(updatedLive.startedAt).getTime();

    void notifyRestoreResult({
      success: updatedLive.status === "complete",
      origin: updatedLive.origin,
      errorMsg: updatedLive.error,
      safetyBackupPath: updatedLive.safetyBackupPath,
      durationMs,
      rolledBack: !!updatedLive.rolledBack,
    });

    try {
      const { logActivity } = await import("./activities-db");
      const ok = updatedLive.status === "complete";
      const originLabel = updatedLive.origin
        ? `${updatedLive.origin.user}@${updatedLive.origin.hostname}`
        : "backup";
      const desc = ok
        ? `Restore concluído: ${originLabel}`
        : `Restore falhou: ${updatedLive.error || "erro desconhecido"}`;
      logActivity("backup", desc, ok ? "success" : "error", {
        duration_ms: durationMs,
        metadata: {
          sessionId: updatedLive.sessionId,
          uploadId: updatedLive.uploadId,
          rolledBack: !!updatedLive.rolledBack,
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
