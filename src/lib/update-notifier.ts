import { addNotification } from "./notifications";
import {
  UpdateCheckResult,
  readUpdateConfig,
  writeUpdateConfig,
} from "./update";

/**
 * Cria uma notificação no sino quando uma atualização nova é detectada.
 * Persiste o SHA notificado em `update-config.json` para evitar spam:
 * a mesma versão remota não dispara duas notificações.
 */
export async function notifyIfNewUpdate(result: UpdateCheckResult): Promise<boolean> {
  if (!result.hasUpdate) return false;

  const config = readUpdateConfig();
  if (config.lastNotifiedSha === result.remoteSha) return false;

  const short = result.remoteSha.slice(0, 7);
  const count = result.behindBy || result.commits.length || 1;
  const headline = result.commits[0]?.message?.slice(0, 80) || "Novos commits no GitHub";

  const message =
    count === 1
      ? `1 commit novo (${short}): ${headline}`
      : `${count} commits novos até ${short}. Último: "${headline}"`;

  try {
    await addNotification(
      "🚀 Atualização disponível",
      message,
      "info",
      "/settings",
      { remoteSha: result.remoteSha, behindBy: count }
    );
    writeUpdateConfig({ lastNotifiedSha: result.remoteSha });
    return true;
  } catch (err) {
    console.error("[update-notifier] Failed to create notification:", err);
    return false;
  }
}

export async function notifyUpdateResult(
  success: boolean,
  fromSha: string,
  toSha: string,
  durationMs?: number,
  errorMsg?: string
): Promise<void> {
  try {
    if (success) {
      const durSec = durationMs ? Math.round(durationMs / 1000) : 0;
      await addNotification(
        "✅ Atualização concluída",
        `Sistema atualizado de ${fromSha} para ${toSha} em ${durSec}s.`,
        "success",
        "/settings"
      );
    } else {
      await addNotification(
        "❌ Atualização falhou",
        errorMsg || `Falha ao atualizar de ${fromSha} para ${toSha}. Verifique os logs.`,
        "error",
        "/settings"
      );
    }
  } catch (err) {
    console.error("[update-notifier] Failed to create result notification:", err);
  }
}
