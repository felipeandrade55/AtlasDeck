import { NextResponse } from "next/server";
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
  liveStatusPath,
  phaseEventsPath,
  readUpdateConfig,
  writeLiveStatus,
} from "@/lib/update";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Inicia um update em modo *detached*: o script roda independente do servidor Next.js,
 * então sobrevive ao restart do PM2 disparado pelo próprio script. O endpoint retorna
 * imediatamente com sessionId; o cliente abre /api/update/stream para acompanhar.
 */
export async function POST() {
  const active = getActiveUpdate();
  if (active?.status === "running") {
    return NextResponse.json(
      { error: "Já existe um update em andamento", sessionId: active.sessionId },
      { status: 409 }
    );
  }

  // Limpa estados anteriores
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

  // Cria os arquivos vazios para o stream conseguir abrir imediatamente
  fs.writeFileSync(liveLogPath(), "");
  fs.writeFileSync(phaseEventsPath(), "");

  // Abre file descriptors para stdout/stderr do filho
  const logFd = fs.openSync(liveLogPath(), "a");

  const scriptPath = path.join(process.cwd(), "scripts", "deploy.sh");
  const args = ["--headless"];
  if (config.backupBeforeUpdate) args.push("--with-backup");
  args.push("--status-file", phaseEventsPath());

  // Detached: cria novo grupo de processos, desliga do parent.
  // Sobrevive ao PM2 restart que o próprio script vai disparar.
  // (O próprio deploy.sh ignora HUP/PIPE — vide trap no topo do script.)
  const child = spawn("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ATLASDECK_UPDATE_SESSION: sessionId },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  if (!child.pid) {
    fs.closeSync(logFd);
    return NextResponse.json(
      { error: "Falha ao iniciar processo de update (sem PID)" },
      { status: 500 }
    );
  }

  // Fecha o FD no parent — o filho mantém sua cópia aberta
  fs.closeSync(logFd);

  // unref para que o servidor Next.js possa morrer sem matar o filho
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
  };

  writeLiveStatus(liveStatus);

  return NextResponse.json({
    sessionId,
    historyId,
    pid: child.pid,
    fromSha,
    toSha,
    phases: initialPhases,
  });
}
