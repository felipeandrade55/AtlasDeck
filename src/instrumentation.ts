/**
 * Next.js instrumentation hook — runs once per Node process at startup.
 * We use it to bootstrap the OpenClaw sessions watcher so chats happening
 * outside the web UI (Telegram, CLI, cron) get imported into the chat-db
 * and counted in Mission Control automatically.
 *
 * Guarded to the `nodejs` runtime: the watcher uses `fs.watch` which is
 * not available in the edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startOpenClawWatcher } = await import("./lib/openclaw-watcher");
    startOpenClawWatcher();
  } catch (err) {
    console.warn("[instrumentation] OpenClaw watcher bootstrap failed:", err);
  }
  try {
    const { startMetricsScheduler } = await import("./lib/metrics-scheduler");
    startMetricsScheduler();
  } catch (err) {
    console.warn("[instrumentation] metrics scheduler bootstrap failed:", err);
  }
  // Make sure the nightly backup cron is registered on a fresh install —
  // idempotent, so existing crontabs are left alone.
  try {
    const { ensureBackupCronInstalled } = await import("./lib/backup");
    const res = ensureBackupCronInstalled();
    if (res.changed) {
      console.log("[instrumentation] Backup cron installed:", res.message);
    }
  } catch (err) {
    console.warn("[instrumentation] Backup cron install failed:", err);
  }
}
