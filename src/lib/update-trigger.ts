import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  UpdateHistoryEntry,
  UpdateLiveStatus,
  addUpdateHistoryEntry,
  buildInitialPhases,
  checkForUpdates,
  clearLiveStatus,
  getActiveUpdate,
  getLocalVersion,
  liveLogPath,
  phaseEventsPath,
  readUpdateConfig,
  writeLiveStatus,
} from "./update";
import { logActivity } from "./activities-db";
import { isContainerDeploy } from "./deploy-mode";

export type TriggerOrigin = "manual" | "auto";

export interface TriggerResult {
  ok: boolean;
  reason?: "already-running" | "no-pid" | "exception" | "container-mode";
  sessionId?: string;
  historyId?: string;
  pid?: number;
  fromSha?: string;
  toSha?: string;
  error?: string;
}

/**
 * Inicia um deploy.sh detached. Compartilhado entre o POST /api/update/start
 * (origin="manual") e o auto-update agendado em update-scheduler (origin="auto").
 *
 * O processo filho roda independente do Next.js (detached + setsid via libuv)
 * e sobrevive ao próprio pm2 restart disparado pelo deploy.sh.
 */
export async function triggerUpdate(origin: TriggerOrigin = "manual"): Promise<TriggerResult> {
  try {
    // Em modo container (Coolify) não existe git pull in-place: o código vive
    // dentro da imagem e a atualização é feita REBUILDANDO a imagem (Coolify
    // clona a main do GitHub). Rodar deploy.sh aqui só resulta em
    // "git: command not found" (exit 127). Recusa com orientação acionável.
    if (isContainerDeploy()) {
      return {
        ok: false,
        reason: "container-mode",
        error:
          "Este AtlasDeck roda em container (Coolify). A atualização não é via git-pull — " +
          "faça um Redeploy no Coolify: ele puxa a última versão da main no GitHub e " +
          "reconstrói a imagem. O update in-app fica desativado nesse modo de propósito.",
      };
    }

    const active = getActiveUpdate();
    if (active?.status === "running") {
      return { ok: false, reason: "already-running", sessionId: active.sessionId };
    }

    clearLiveStatus();
    try { fs.unlinkSync(liveLogPath()); } catch {}
    try { fs.unlinkSync(phaseEventsPath()); } catch {}

    const config = readUpdateConfig();
    const sessionId = randomUUID();
    const historyId = new Date().toISOString();
    const startedAt = historyId;

    let fromSha = "unknown";
    try {
      const local = await getLocalVersion();
      fromSha = local.short;
    } catch {}

    let toSha = "unknown";
    try {
      const chk = await checkForUpdates(true);
      toSha = chk.remoteSha.slice(0, 7);
    } catch {}

    const initialPhases = buildInitialPhases(config.backupBeforeUpdate);

    const historyEntry: UpdateHistoryEntry = {
      id: historyId,
      fromSha,
      toSha,
      status: "running",
      startedAt,
      phases: initialPhases,
      logs: "",
    };
    addUpdateHistoryEntry(historyEntry);

    const dataDir = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(liveLogPath(), "");
    fs.writeFileSync(phaseEventsPath(), "");

    const logFd = fs.openSync(liveLogPath(), "a");

    const scriptPath = path.join(process.cwd(), "scripts", "deploy.sh");
    const args = ["--headless"];
    if (config.backupBeforeUpdate) args.push("--with-backup");
    args.push("--status-file", phaseEventsPath());

    const child = spawn("bash", [scriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATLASDECK_UPDATE_SESSION: sessionId,
        ATLASDECK_UPDATE_ORIGIN: origin,
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

    const liveStatus: UpdateLiveStatus = {
      sessionId,
      historyId,
      pid: child.pid,
      status: "running",
      startedAt,
      lastHeartbeat: new Date().toISOString(),
      currentPhase: config.backupBeforeUpdate ? "backup" : "credentials",
      phases: initialPhases,
      fromSha,
      toSha,
      logFile: liveLogPath(),
      statusFile: phaseEventsPath(),
      origin,
    };
    writeLiveStatus(liveStatus);

    try {
      const verb = origin === "auto" ? "Auto-update iniciado" : "Update iniciado";
      logActivity("update", `${verb}: ${fromSha} → ${toSha}`, "pending", {
        metadata: { sessionId, historyId, fromSha, toSha, pid: child.pid, origin },
      });
    } catch {}

    return { ok: true, sessionId, historyId, pid: child.pid, fromSha, toSha };
  } catch (err) {
    return {
      ok: false,
      reason: "exception",
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
