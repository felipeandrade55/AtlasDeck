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

  // openclaw.json schema sweep — strip AtlasDeck-only / unknown fields from
  // channels.{telegram,whatsapp}.accounts.<id>. OpenClaw v2026.5.12+ rejects
  // extra keys with "must NOT have additional properties" and the daemon
  // refuses to boot, taking the Telegram bot down with it. We do this BEFORE
  // the health monitor starts so a restart attempt finds a clean config.
  //
  // Implementation lives in @/lib/openclaw-config-sweep so Turbopack's static
  // analysis doesn't see Node-only `fs` imports in instrumentation.ts and
  // surface a misleading Edge-runtime warning for routes that re-import this file.
  try {
    const { sweepOpenClawConfig } = await import("@/lib/openclaw-config-sweep");
    const r = sweepOpenClawConfig();
    if (r.ran && (r.changedTelegram || r.changedWhatsapp)) {
      console.log(
        `[instrumentation] openclaw.json schema sweep wrote changes (telegram=${r.changedTelegram} whatsapp=${r.changedWhatsapp})`,
      );
    } else if (r.error) {
      console.warn("[instrumentation] openclaw.json schema sweep error:", r.error);
    }
  } catch (err) {
    console.warn("[instrumentation] openclaw.json schema sweep failed:", err);
  }

  // openclaw.json file watcher. Re-runs the sweep with a 3s debounce
  // whenever the file changes, so external writers (jarvis-dashboard, manual
  // edits, the gateway persisting session state during WhatsApp pairing)
  // can't leave the config in a state that would crash the gateway on its
  // next restart. Boot-time sweep above covers the cold start; this covers
  // everything after.
  try {
    const { startOpenClawConfigWatcher } = await import("@/lib/openclaw-config-watcher");
    startOpenClawConfigWatcher();
  } catch (err) {
    console.warn("[instrumentation] failed to start openclaw.json watcher:", err);
  }

  // Telegram + OpenClaw watchdog. Boots here so auto-restart kicks in even
  // when the dashboard tab is closed (the bell GET would otherwise be the
  // only thing booting it).
  try {
    const { startHealthMonitor } = await import("@/lib/health-monitor");
    startHealthMonitor();
  } catch (err) {
    console.warn("[instrumentation] failed to start health monitor:", err);
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
