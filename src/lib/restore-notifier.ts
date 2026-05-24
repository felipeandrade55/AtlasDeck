import type { BackupOrigin } from "./backup";
import { addNotification } from "./notifications";

export interface NotifyRestoreParams {
  success: boolean;
  origin: BackupOrigin | null | undefined;
  errorMsg?: string;
  safetyBackupPath?: string;
  durationMs?: number;
  rolledBack?: boolean;
}

export async function notifyRestoreResult(p: NotifyRestoreParams): Promise<void> {
  const originLabel = p.origin
    ? `${p.origin.user}@${p.origin.hostname} (${p.origin.platform})`
    : "backup";
  const durSec = p.durationMs ? Math.round(p.durationMs / 1000) : 0;
  const durStr = durSec >= 60 ? `${Math.floor(durSec / 60)}m${durSec % 60}s` : `${durSec}s`;

  try {
    if (p.success) {
      await addNotification(
        "Restauração concluída",
        `Dados restaurados a partir de ${originLabel} em ${durStr}. Sistema online com o backup aplicado.`,
        "success",
        "/settings",
        {
          safetyBackupPath: p.safetyBackupPath,
          durationMs: p.durationMs,
        }
      );
    } else if (p.rolledBack) {
      await addNotification(
        "Restauração revertida",
        `Falha detectada: ${p.errorMsg || "erro desconhecido"}. O snapshot pré-restore foi re-aplicado automaticamente.`,
        "warning",
        "/settings",
        { safetyBackupPath: p.safetyBackupPath, error: p.errorMsg }
      );
    } else {
      await addNotification(
        "Falha na restauração",
        p.errorMsg || "Erro desconhecido durante o restore.",
        "error",
        "/settings",
        { safetyBackupPath: p.safetyBackupPath, error: p.errorMsg }
      );
    }
  } catch (err) {
    console.error("[restore-notifier] failed to create notification:", err);
  }
}
