import fs from "fs";
import path from "path";
import type { BackupOrigin, RestorePreview } from "./backup";

export type RestorePhaseName =
  | "validate"
  | "safety-backup"
  | "preview"
  | "stop-app"
  | "extract"
  | "apply-data"
  | "apply-env"
  | "apply-home"
  | "restart-openclaw"
  | "start-app"
  | "verify"
  | "rollback";

export interface RestorePhase {
  name: string;
  status: "pending" | "running" | "ok" | "fail" | "skip";
  startedAt?: string;
  completedAt?: string;
  durationSec?: number;
  error?: string;
}

export interface RestoreLiveStatus {
  sessionId: string;
  pid: number;
  status: "running" | "complete" | "error" | "rolled-back" | "manual-recovery";
  startedAt: string;
  completedAt?: string;
  lastHeartbeat: string;
  currentPhase: string;
  phases: RestorePhase[];
  uploadId: string;
  archivePath: string;
  /** Path of the pre-restore safety snapshot, when created. */
  safetyBackupPath?: string;
  /** Whether PM2 manages the atlasdeck process — false in dev (npm run dev). */
  pm2Managed: boolean;
  /** Backup origin parsed from the upload (host, platform, user). */
  origin?: BackupOrigin | null;
  /** Preview computed in fase `preview`. */
  preview?: RestorePreview | null;
  logFile: string;
  statusFile: string;
  /** Generic error message captured when status flips to "error". */
  error?: string;
  /** True once the rollback re-applied the safety backup. */
  rolledBack?: boolean;
}

export const RESTORE_PHASE_ORDER: RestorePhaseName[] = [
  "validate",
  "safety-backup",
  "preview",
  "stop-app",
  "extract",
  "apply-data",
  "apply-env",
  "apply-home",
  "restart-openclaw",
  "start-app",
  "verify",
];

export const RESTORE_PHASE_LABELS: Record<string, string> = {
  validate: "Validar arquivo",
  "safety-backup": "Snapshot pré-restore",
  preview: "Plano de restauração",
  "stop-app": "Parar aplicação",
  extract: "Extrair backup",
  "apply-data": "Aplicar dados",
  "apply-env": "Aplicar .env",
  "apply-home": "Aplicar ~/.openclaw + ~/.claude",
  "restart-openclaw": "Reiniciar OpenClaw Gateway",
  "start-app": "Iniciar aplicação",
  verify: "Verificar saúde",
  rollback: "Reverter (rollback)",
};

export function restoreLiveStatusPath(): string {
  return path.join(process.cwd(), "data", "restore-live-status.json");
}

export function restoreLogPath(): string {
  return path.join(process.cwd(), "data", "restore-current.log");
}

export function restorePhaseEventsPath(): string {
  return path.join(process.cwd(), "data", "restore-phase-events.log");
}

export function restoreUploadsDir(): string {
  return path.join(process.cwd(), "data", ".restore-uploads");
}

export function readRestoreLiveStatus(): RestoreLiveStatus | null {
  try {
    const raw = fs.readFileSync(restoreLiveStatusPath(), "utf-8");
    return JSON.parse(raw) as RestoreLiveStatus;
  } catch {
    return null;
  }
}

export function writeRestoreLiveStatus(status: RestoreLiveStatus) {
  fs.mkdirSync(path.dirname(restoreLiveStatusPath()), { recursive: true });
  fs.writeFileSync(restoreLiveStatusPath(), JSON.stringify(status, null, 2), "utf-8");
}

export function clearRestoreLiveStatus() {
  try {
    fs.unlinkSync(restoreLiveStatusPath());
  } catch {}
}

export function buildInitialRestorePhases(opts: {
  withSafetyBackup: boolean;
  pm2Managed: boolean;
}): RestorePhase[] {
  return RESTORE_PHASE_ORDER.filter((name) => {
    if (!opts.withSafetyBackup && name === "safety-backup") return false;
    return true;
  }).map((name) => {
    const phase: RestorePhase = { name, status: "pending" };
    if (!opts.pm2Managed && (name === "stop-app" || name === "start-app" || name === "verify")) {
      // Dev local: marca como skip visualmente já — o script confirma com phase_status.
      phase.status = "pending";
    }
    return phase;
  });
}

function freshestArtifactMs(): number {
  let latest = 0;
  for (const p of [restorePhaseEventsPath(), restoreLogPath()]) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {}
  }
  return latest;
}

const DEAD_THRESHOLD_MS = 300_000; // 5 min — mesmo timeout do update

/**
 * Mesma estratégia de `getActiveUpdate` no sistema de update: combina o
 * heartbeat persistido com o mtime dos artefatos para detectar processos que
 * morreram sem emitir terminal. Se o PID estiver morto e os arquivos forem
 * antigos, marca como erro.
 */
export function getActiveRestore(): RestoreLiveStatus | null {
  const status = readRestoreLiveStatus();
  if (!status) return null;
  if (status.status !== "running") return status;

  const persistedHb = new Date(status.lastHeartbeat).getTime();
  const artifactHb = freshestArtifactMs();
  const effectiveHb = Math.max(persistedHb, artifactHb);

  if (artifactHb > persistedHb) {
    status.lastHeartbeat = new Date(artifactHb).toISOString();
  }

  const ageMs = Date.now() - effectiveHb;

  if (ageMs > DEAD_THRESHOLD_MS) {
    let alive = false;
    if (status.pid > 0) {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }

    if (!alive) {
      const reconciled: RestoreLiveStatus = {
        ...status,
        status: "error",
        error: `Processo de restore encerrou inesperadamente (sem heartbeat há mais de ${Math.round(
          DEAD_THRESHOLD_MS / 1000
        )}s).`,
        completedAt: new Date().toISOString(),
      };
      writeRestoreLiveStatus(reconciled);
      return reconciled;
    }
  }

  return status;
}

export function isRestoreRunning(): boolean {
  const live = getActiveRestore();
  return live?.status === "running";
}
