import { addNotification } from "./notifications";
import {
  UpdateCheckResult,
  UpdatePhase,
  PHASE_LABELS,
  readUpdateConfig,
  writeUpdateConfig,
} from "./update";

/**
 * Cria uma notificação no sino quando uma atualização nova é detectada.
 * Persiste o SHA notificado em `update-config.json` para evitar spam:
 * a mesma versão remota não dispara duas notificações.
 *
 * IMPORTANTE: se autoUpdate=true, esta notificação serve apenas como log;
 * a notificação "🤖 Auto-update iniciando" do scheduler vem logo depois.
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

function buildPhaseBriefing(phases: UpdatePhase[] | undefined): string {
  if (!phases || phases.length === 0) return "";

  const okPhases = phases.filter((p) => p.status === "ok").map((p) => PHASE_LABELS[p.name] || p.name);
  const skipPhases = phases.filter((p) => p.status === "skip").map((p) => PHASE_LABELS[p.name] || p.name);
  const failPhases = phases.filter((p) => p.status === "fail").map((p) => PHASE_LABELS[p.name] || p.name);

  const lines: string[] = [];
  if (failPhases.length > 0) lines.push(`✗ Falhou: ${failPhases.join(", ")}`);
  if (okPhases.length > 0) lines.push(`✓ Concluído: ${okPhases.join(", ")}`);
  if (skipPhases.length > 0) lines.push(`– Pulado: ${skipPhases.join(", ")}`);
  return lines.join(" • ");
}

export interface UpdateResultDetails {
  durationMs?: number;
  errorMsg?: string;
  origin?: "manual" | "auto";
  phases?: UpdatePhase[];
  commitsApplied?: number;
}

export async function notifyUpdateResult(
  success: boolean,
  fromSha: string,
  toSha: string,
  details?: UpdateResultDetails | number,
  legacyErrorMsg?: string
): Promise<void> {
  // Backwards-compat: assinatura antiga era (success, from, to, durationMs?, errorMsg?)
  const opts: UpdateResultDetails =
    typeof details === "number" || details === undefined
      ? { durationMs: typeof details === "number" ? details : undefined, errorMsg: legacyErrorMsg }
      : details;

  const { durationMs, errorMsg, origin = "manual", phases, commitsApplied } = opts;
  const durSec = durationMs ? Math.round(durationMs / 1000) : 0;
  const durStr = durSec >= 60 ? `${Math.floor(durSec / 60)}m${durSec % 60}s` : `${durSec}s`;
  const prefix = origin === "auto" ? "Auto-update" : "Atualização";

  try {
    if (success) {
      const briefing = buildPhaseBriefing(phases);
      const commitsLine = commitsApplied
        ? `${commitsApplied} commit${commitsApplied > 1 ? "s" : ""} aplicado${commitsApplied > 1 ? "s" : ""}. `
        : "";
      const tail = briefing ? ` Briefing: ${briefing}.` : "";
      await addNotification(
        `✅ ${prefix} concluída`,
        `${fromSha} → ${toSha} em ${durStr}. ${commitsLine}Sistema atualizado e online.${tail}`,
        "success",
        "/settings",
        { origin, fromSha, toSha, durationMs, phases: phases?.map((p) => ({ name: p.name, status: p.status })) }
      );
    } else {
      const briefing = buildPhaseBriefing(phases);
      const tail = briefing ? ` Briefing: ${briefing}.` : "";
      await addNotification(
        `❌ ${prefix} falhou`,
        `${errorMsg || `Falha ao atualizar de ${fromSha} para ${toSha}`}${tail}`,
        "error",
        "/settings",
        { origin, fromSha, toSha, durationMs, error: errorMsg }
      );
    }
  } catch (err) {
    console.error("[update-notifier] Failed to create result notification:", err);
  }
}
