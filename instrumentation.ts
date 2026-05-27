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

  // Learner Agent — hourly scan over approved/rejected tasks → preference
  // model. Idempotent so reruns are cheap; the cron just keeps the watermark
  // ticking forward without waiting for someone to hit /api/learner/run.
  try {
    const { startLearnerScheduler } = await import("@/lib/learner-scheduler");
    startLearnerScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start learner scheduler:", err);
  }

  // Memory MCP — write the atlasdeck-memory entry into
  // ~/.openclaw/mcp.json so the agent gets real memory tools on its
  // next boot. We intentionally DO NOT restart the gateway here —
  // that would interrupt any in-flight conversation. The IntegrationStatus
  // card surfaces a "reload now" prompt to the user when needed.
  //
  // The fs.existsSync(openclawDir) guard lives INSIDE the orchestrator,
  // not here, so Turbopack's static analysis doesn't see a Node-only
  // import in instrumentation.ts (which it tags as edge-eligible even
  // when our own runtime check at the top would skip it).
  try {
    const { ensureMemoryMcpInstalledQuiet } = await import(
      "@/lib/memory-mcp-orchestrator"
    );
    const r = ensureMemoryMcpInstalledQuiet({
      agentId: "main",
      skipIfOpenClawMissing: true,
    });
    if (r.ok && r.changed) {
      console.log(
        "[instrumentation] atlasdeck-memory MCP entry written/updated in mcp.json",
      );
    } else if (!r.ok) {
      console.warn(
        "[instrumentation] failed to ensure memory MCP install:",
        r.error,
      );
    }
  } catch (err) {
    console.warn("[instrumentation] memory MCP install hook failed:", err);
  }
}
