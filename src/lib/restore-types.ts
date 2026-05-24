/**
 * Browser-safe types and constants for the restore flow.
 *
 * This file MUST stay free of Node-only imports (fs, path, child_process, etc.)
 * because it is imported by the client-side RestorePanel.tsx. Turbopack/webpack
 * try to bundle every transitive dependency of a "use client" component for the
 * browser, and `fs` blows up there.
 *
 * Heavy I/O helpers live in `src/lib/restore.ts` (server-only).
 */

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

// ─── Audit types ─────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "disk-full"
  | "permission-denied"
  | "tar-corrupt"
  | "archive-missing-marker"
  | "platform-mismatch"
  | "pm2-missing"
  | "pm2-start-timeout"
  | "health-check-failed"
  | "db-corrupt"
  | "preview-failed"
  | "cancelled"
  | "unknown";

export interface PhaseAudit {
  name: string;
  label: string;
  status: RestorePhase["status"];
  durationSec?: number;
  error?: string;
  bytesRestored?: number;
  filesRestored?: number;
}

export interface RestoreAudit {
  sessionId: string;
  overallStatus: "success" | "rolled-back" | "failed-no-rollback" | "manual-recovery";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  origin: {
    user?: string;
    hostname?: string;
    platform?: string;
    homeDir?: string;
  } | null;
  safetyBackupPath?: string;
  rolledBack: boolean;
  pm2Managed: boolean;
  phases: PhaseAudit[];
  inventory: {
    safetyBackupCreated: boolean;
    appStopped: boolean;
    archiveExtracted: boolean;
    dataApplied: boolean;
    envApplied: boolean;
    homeApplied: boolean;
    openclawRestarted: boolean;
    appStarted: boolean;
    healthVerified: boolean;
  };
  failedPhase?: string;
  errorCategory?: ErrorCategory;
  errorTitle?: string;
  errorExplanation?: string;
  errorImpact?: string;
  suggestedActions?: string[];
  headline: string;
}
