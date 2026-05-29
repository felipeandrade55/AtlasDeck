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
  // Telegram + gateway watchdog. Idempotent; was previously triggered only
  // when the dashboard hit /api/notifications — meaning a closed dashboard
  // left the bot unwatched. Starting at boot makes auto-recovery work
  // regardless of whether a browser is open.
  try {
    const { startHealthMonitor } = await import("./lib/health-monitor");
    startHealthMonitor();
  } catch (err) {
    console.warn("[instrumentation] health monitor bootstrap failed:", err);
  }
  // Agent-load watchdog. Polls gateway logs for "prompt token usage" and
  // "turn idle timed out" so the diagnose card can show context headroom
  // and (opt-in via AGENT_LOAD_AUTO_ROTATE=on) auto-rotate the Telegram
  // session before the next message hits the overflow wall.
  try {
    const { startAgentLoadWatchdog } = await import("./lib/agent-load-watchdog");
    startAgentLoadWatchdog();
  } catch (err) {
    console.warn("[instrumentation] agent-load watchdog bootstrap failed:", err);
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
