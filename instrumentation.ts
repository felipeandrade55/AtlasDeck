/**
 * Next.js startup hook. Runs once per server process.
 *
 * Used to boot the memory subsystem scheduler (extraction, injection,
 * housekeeping). Safe to no-op in non-Node runtimes.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startMemoryScheduler } = await import("@/lib/memory-scheduler");
    startMemoryScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start memory scheduler:", err);
  }

  try {
    const { startMetricsScheduler } = await import("@/lib/metrics-scheduler");
    startMetricsScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start metrics scheduler:", err);
  }

  // Auto-install the nightly backup cron on a fresh install. Idempotent:
  // no-ops if a cron line already exists or if config.enabled is false.
  try {
    const { ensureBackupCronInstalled } = await import("@/lib/backup");
    const result = ensureBackupCronInstalled();
    if (result.changed) {
      console.log(`[instrumentation] backup cron installed: ${result.message}`);
    }
  } catch (err) {
    console.warn("[instrumentation] failed to ensure backup cron:", err);
  }
}
