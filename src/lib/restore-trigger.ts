import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { previewRestore } from "./backup";
import {
  RestoreLiveStatus,
  buildInitialRestorePhases,
  clearRestoreLiveStatus,
  getActiveRestore,
  restoreLogPath,
  restorePhaseEventsPath,
  writeRestoreLiveStatus,
} from "./restore";
import { logActivity } from "./activities-db";

export interface TriggerRestoreOptions {
  uploadId: string;
  archivePath: string;
  createSafetyBackup: boolean;
}

export interface TriggerRestoreResult {
  ok: boolean;
  reason?: "already-running" | "no-pid" | "exception" | "preview-failed";
  sessionId?: string;
  pid?: number;
  error?: string;
}

function detectPm2Managed(appName = "atlasdeck"): boolean {
  try {
    const out = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    return out.includes(`"name":"${appName}"`);
  } catch {
    return false;
  }
}

export async function triggerRestore(
  opts: TriggerRestoreOptions
): Promise<TriggerRestoreResult> {
  try {
    const active = getActiveRestore();
    if (active?.status === "running") {
      return { ok: false, reason: "already-running", sessionId: active.sessionId };
    }

    // Sanity-check via preview before spawning. Catches platform mismatch,
    // missing origin manifest, corrupted tar — surfacing a clean 4xx instead
    // of spawning a process just to have it fail in fase 1.
    let preview;
    try {
      preview = await previewRestore(opts.archivePath);
    } catch (err) {
      return {
        ok: false,
        reason: "preview-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    clearRestoreLiveStatus();
    try { fs.unlinkSync(restoreLogPath()); } catch {}
    try { fs.unlinkSync(restorePhaseEventsPath()); } catch {}

    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const pm2Managed = detectPm2Managed();

    const dataDir = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(restoreLogPath(), "");
    fs.writeFileSync(restorePhaseEventsPath(), "");

    const logFd = fs.openSync(restoreLogPath(), "a");
    const scriptPath = path.join(process.cwd(), "scripts", "restore.sh");

    const args = [
      scriptPath,
      "--archive", opts.archivePath,
      "--upload-id", opts.uploadId,
      "--status-file", restorePhaseEventsPath(),
      "--log-file", restoreLogPath(),
    ];
    if (opts.createSafetyBackup) args.push("--safety-backup");

    const child = spawn("bash", args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATLASDECK_RESTORE_SESSION: sessionId,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    if (!child.pid) {
      fs.closeSync(logFd);
      return { ok: false, reason: "no-pid" };
    }

    fs.closeSync(logFd);
    child.unref();

    const initialPhases = buildInitialRestorePhases({
      withSafetyBackup: opts.createSafetyBackup,
      pm2Managed,
    });

    const liveStatus: RestoreLiveStatus = {
      sessionId,
      pid: child.pid,
      status: "running",
      startedAt,
      lastHeartbeat: startedAt,
      currentPhase: "validate",
      phases: initialPhases,
      uploadId: opts.uploadId,
      archivePath: opts.archivePath,
      pm2Managed,
      origin: preview.origin,
      preview,
      logFile: restoreLogPath(),
      statusFile: restorePhaseEventsPath(),
    };
    writeRestoreLiveStatus(liveStatus);

    try {
      const originLabel = preview.origin
        ? `${preview.origin.user}@${preview.origin.hostname}`
        : "backup";
      logActivity("backup", `Restore iniciado: ${originLabel}`, "pending", {
        metadata: {
          sessionId,
          uploadId: opts.uploadId,
          archivePath: opts.archivePath,
          pid: child.pid,
          pm2Managed,
        },
      });
    } catch {}

    return { ok: true, sessionId, pid: child.pid };
  } catch (err) {
    return {
      ok: false,
      reason: "exception",
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
