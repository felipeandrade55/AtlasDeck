/**
 * Next.js instrumentation hook — runs once per Node process at startup.
 *
 * ⚠️ SINGLE SOURCE OF TRUTH for boot bootstraps. Next.js loads the
 * instrumentation file next to the `app` dir — i.e. THIS file (`src/`),
 * NOT the root `/instrumentation.ts`. The two had drifted, silently
 * disabling everything that lived only in the root file (memory
 * scheduler, learner, openclaw config sweep/watcher, boot MCP install).
 * The root file now just re-exports this one so they can never diverge
 * again. Put new bootstraps HERE.
 *
 * Guarded to the `nodejs` runtime: most hooks use `fs`, which is not
 * available in the edge runtime. Every bootstrap is dynamically imported
 * (so Turbopack's static analysis doesn't tag this file edge-ineligible)
 * and individually try/caught (so one failure can't take the rest down).
 * The schedulers are internally idempotent — safe even if both
 * instrumentation files were ever loaded.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ─── openclaw.json schema sweep ────────────────────────────────────
  // Strip AtlasDeck-only / unknown fields that OpenClaw v2026.5.12+
  // rejects ("must NOT have additional properties"), which would make the
  // daemon refuse to boot and take the Telegram bot down. Runs FIRST so a
  // health-monitor restart finds a clean config.
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

  // openclaw.json file watcher — re-runs the sweep (3s debounce) whenever
  // an external writer touches the file, so it can't leave a config that
  // crashes the gateway on its next restart.
  try {
    const { startOpenClawConfigWatcher } = await import("@/lib/openclaw-config-watcher");
    startOpenClawConfigWatcher();
  } catch (err) {
    console.warn("[instrumentation] failed to start openclaw.json watcher:", err);
  }

  // OpenClaw sessions watcher — imports chats happening outside the web UI
  // (Telegram, CLI, cron) into the chat-db so Mission Control counts them.
  try {
    const { startOpenClawWatcher } = await import("@/lib/openclaw-watcher");
    startOpenClawWatcher();
  } catch (err) {
    console.warn("[instrumentation] OpenClaw watcher bootstrap failed:", err);
  }

  // Memory subsystem scheduler — extraction (every 15m, pulls new exchanges
  // from session JSONLs → structured memories), injection (regenerates the
  // AUTO_RECALL block in MEMORY.md), housekeeping (archives stale low-value
  // memories). THIS is the "learn on its own" engine; it was off because it
  // only lived in the ignored root instrumentation file.
  try {
    const { startMemoryScheduler } = await import("@/lib/memory-scheduler");
    startMemoryScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start memory scheduler:", err);
  }

  // Metrics scheduler.
  try {
    const { startMetricsScheduler } = await import("@/lib/metrics-scheduler");
    startMetricsScheduler();
  } catch (err) {
    console.warn("[instrumentation] metrics scheduler bootstrap failed:", err);
  }

  // Telegram + gateway health monitor / watchdog. Boots here so
  // auto-recovery works even with the dashboard tab closed.
  try {
    const { startHealthMonitor } = await import("@/lib/health-monitor");
    startHealthMonitor();
  } catch (err) {
    console.warn("[instrumentation] health monitor bootstrap failed:", err);
  }

  // VPS health monitor — flips remote VPS hosts offline when their heartbeat
  // (last ingest) goes stale, firing the Telegram/offline alert. Boots here so
  // offline detection works with the dashboard closed.
  try {
    const { startVpsHealthMonitor } = await import("@/lib/vps-health-monitor");
    startVpsHealthMonitor();
  } catch (err) {
    console.warn("[instrumentation] vps health monitor bootstrap failed:", err);
  }

  // Agent-load watchdog — polls gateway logs for context-usage / idle-timeout
  // so the diagnose card shows headroom and (opt-in) auto-rotates the
  // Telegram session before the next message hits the overflow wall.
  try {
    const { startAgentLoadWatchdog } = await import("@/lib/agent-load-watchdog");
    startAgentLoadWatchdog();
  } catch (err) {
    console.warn("[instrumentation] agent-load watchdog bootstrap failed:", err);
  }

  // WhatsApp rotation watchdog — schedule-based session rotation at the
  // interval the user picks. Off by default; turns on from the UI.
  try {
    const { startWhatsappRotationWatchdog } = await import("@/lib/whatsapp-rotation-watchdog");
    startWhatsappRotationWatchdog();
  } catch (err) {
    console.warn("[instrumentation] whatsapp rotation watchdog bootstrap failed:", err);
  }

  // Learner Agent — hourly scan over approved/rejected tasks → preference
  // model. Idempotent; keeps the watermark ticking without waiting for a
  // manual /api/learner/run.
  try {
    const { startLearnerScheduler } = await import("@/lib/learner-scheduler");
    startLearnerScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start learner scheduler:", err);
  }

  // Nightly backup cron — idempotent; no-ops if a cron line already exists
  // or config.enabled is false.
  try {
    const { ensureBackupCronInstalled } = await import("@/lib/backup");
    const res = ensureBackupCronInstalled();
    if (res.changed) {
      console.log("[instrumentation] Backup cron installed:", res.message);
    }
  } catch (err) {
    console.warn("[instrumentation] Backup cron install failed:", err);
  }

  // Memory MCP — write the atlasdeck-memory entry into openclaw.json so the
  // agent gets real memory tools on its next boot. Does NOT restart the
  // gateway (would interrupt in-flight chats); the card surfaces a reload
  // prompt when needed. Guard lives inside the orchestrator.
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
        "[instrumentation] atlasdeck-memory MCP entry written/updated in openclaw.json",
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

  // WhatsApp briefing ingester — reconstructs the assessor briefing from
  // session transcripts so the audit trail no longer depends on the model
  // voluntarily calling the briefing tool. Idempotent (dedup + cursor).
  try {
    const { startWhatsappBriefingScheduler } = await import(
      "@/lib/whatsapp-briefing-scheduler"
    );
    startWhatsappBriefingScheduler();
  } catch (err) {
    console.warn("[instrumentation] whatsapp briefing scheduler bootstrap failed:", err);
  }

  // Activity bootstrap — if the activity DB is empty, seed it with real
  // system-state activities so the dashboard "Atividade Recente" never
  // looks mocked or static on fresh installs.
  try {
    const { bootstrapActivities } = await import("@/lib/activity-bootstrap");
    await bootstrapActivities();
  } catch (err) {
    console.warn("[instrumentation] activity bootstrap failed:", err);
  }
}
