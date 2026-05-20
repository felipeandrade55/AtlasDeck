import { checkForUpdates, readUpdateConfig } from "./update";
import { notifyIfNewUpdate } from "./update-notifier";

let started = false;
let timer: NodeJS.Timeout | null = null;
let lastRun = 0;

const MIN_INTERVAL_MS = 60_000;

async function tick() {
  try {
    const result = await checkForUpdates(true);
    await notifyIfNewUpdate(result);
  } catch (err) {
    console.warn("[update-scheduler] check failed:", err);
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

  const config = readUpdateConfig();
  if (!config.autoCheck) {
    console.log("[update-scheduler] autoCheck desabilitado — não iniciando agendador");
    return;
  }

  const intervalMs = Math.max(MIN_INTERVAL_MS, (config.checkIntervalMinutes || 5) * 60_000);
  console.log(
    `[update-scheduler] iniciando — intervalo ${Math.round(intervalMs / 1000)}s`
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
