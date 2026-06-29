import { addNotification } from "./notifications";
import { checkForUpdates, getActiveUpdate, readUpdateConfig, writeUpdateConfig } from "./update";
import { notifyIfNewUpdate } from "./update-notifier";
import { triggerUpdate } from "./update-trigger";
import { isContainerDeploy } from "./deploy-mode";

let started = false;
let timer: NodeJS.Timeout | null = null;
let lastRun = 0;

const MIN_INTERVAL_MS = 60_000;

async function tick() {
  try {
    const result = await checkForUpdates(true);
    await notifyIfNewUpdate(result);
    await maybeAutoUpdate(result);
  } catch (err) {
    console.warn("[update-scheduler] check failed:", err);
  }
}

/**
 * Se autoUpdate=true e o scheduler acabou de detectar uma versão nova
 * (que ainda não tentamos automaticamente), dispara o deploy.sh detached.
 *
 * Anti-loop: persiste `lastAutoUpdateAttemptSha` no config; só tenta de
 * novo quando aparecer um SHA *diferente* do que já tentamos. Se o update
 * falhar, o usuário ainda pode retry manual pela UI — esse path NÃO usa
 * `lastAutoUpdateAttemptSha`.
 */
async function maybeAutoUpdate(result: Awaited<ReturnType<typeof checkForUpdates>>) {
  if (!result.hasUpdate) return;

  // Em container (Coolify), atualização = rebuild da imagem. O check ainda
  // roda (notifica "versão nova"), mas não tentamos auto-disparar deploy.sh,
  // que falharia com exit 127. O usuário faz o Redeploy no Coolify.
  if (isContainerDeploy()) return;

  const config = readUpdateConfig();
  if (!config.autoUpdate) return;

  if (config.lastAutoUpdateAttemptSha === result.remoteSha) {
    // Já tentamos auto-update para esta versão; não insistir.
    return;
  }

  // Se já existe um update rodando (manual ou auto anterior), não disparar.
  const active = getActiveUpdate();
  if (active?.status === "running") return;

  const short = result.remoteSha.slice(0, 7);
  console.log(`[update-scheduler] auto-update disparando para ${short}`);

  // Notifica que vai começar — separado da notificação "update disponível"
  // para o usuário entender que é o sistema que está agindo.
  try {
    await addNotification(
      "🤖 Auto-update iniciando",
      `Versão nova detectada (${short}). O sistema vai se atualizar agora conforme a política de auto-update.`,
      "info",
      "/settings",
      { remoteSha: result.remoteSha, origin: "auto" }
    );
  } catch (err) {
    console.warn("[update-scheduler] failed to create starting notification:", err);
  }

  // Marca tentativa ANTES do trigger pra não disparar de novo se algo der pau.
  writeUpdateConfig({ lastAutoUpdateAttemptSha: result.remoteSha });

  const trigger = await triggerUpdate("auto");
  if (!trigger.ok) {
    console.warn(`[update-scheduler] auto-update failed to start: ${trigger.reason}`);
    try {
      await addNotification(
        "❌ Auto-update não iniciou",
        `Falha ao iniciar processo: ${trigger.error || trigger.reason || "erro desconhecido"}. Tente atualizar manualmente em Configurações.`,
        "error",
        "/settings"
      );
    } catch {}
  }
}

/**
 * Inicia o agendador singleton. Chamadas repetidas são no-op.
 * Pode ser invocado lazily (na primeira request) para evitar
 * problemas com edge runtime/build time.
 */
export function startUpdateScheduler() {
  if (started) return;
  started = true;

  // Em container (Coolify) não há .git local: checkForUpdates lança
  // "Could not determine local git version" a cada tick, poluindo o log.
  // Atualização nesse modo é via rebuild da imagem — nada pra agendar.
  if (isContainerDeploy()) {
    console.log(
      "[update-scheduler] modo container — atualização via rebuild da imagem (Coolify). Scheduler não iniciado.",
    );
    return;
  }

  const config = readUpdateConfig();
  if (!config.autoCheck) {
    console.log("[update-scheduler] autoCheck desabilitado — não iniciando agendador");
    return;
  }

  const intervalMs = Math.max(MIN_INTERVAL_MS, (config.checkIntervalMinutes || 5) * 60_000);
  console.log(
    `[update-scheduler] iniciando — intervalo ${Math.round(intervalMs / 1000)}s, autoUpdate=${config.autoUpdate}`
  );

  // Primeira execução após 10s (dá tempo do servidor estabilizar)
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
  }, 10_000);
}

/**
 * Garante que o check rodou nos últimos N segundos.
 * Útil para acoplar a /api/notifications (que é polled pelo sino).
 */
export async function ensureRecentCheck(maxAgeMs = 5 * 60_000): Promise<void> {
  if (!started) startUpdateScheduler();
  const now = Date.now();
  if (now - lastRun < maxAgeMs) return;
  lastRun = now;
  await tick();
}
