/**
 * Background watcher for the Telegram + OpenClaw stack. Mirrors the
 * `update-scheduler` pattern: a single in-process timer that ticks every
 * few minutes, runs the diagnostic, and pushes notifications to the bell
 * when state changes from "healthy → degraded" or back.
 *
 * Design rules:
 *   1. The tick NEVER sends a Telegram test message — that would spam the
 *      user's chat. Tests are user-initiated through the doctor UI.
 *   2. State transitions are the signal, not raw checks. Going from 0
 *      failures to 3 failures emits one notification; staying at 3 emits
 *      zero. Going back to 0 emits a "recovered" notification.
 *   3. Per-check throttling: even if a check flaps in/out, we cap one
 *      "broken" notification per check_id per `THROTTLE_MS` window, so the
 *      bell doesn't drown the user.
 *   4. Best-effort persistence — the in-memory state is good enough; a
 *      process restart re-baselines on the first tick.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { addNotification } from "./notifications";
import { runDiagnose, type DiagnosticCheck, type DiagnoseResponse } from "./telegram-diagnostic";
import { startGateway, restartGateway, gatewayLogs } from "./gateway-control";
import type { SweepResult } from "./openclaw-config-sweep";

/**
 * Short human-readable suffix added to bell notifications when an
 * auto-restart ran the sweep. Surfacing this to the user explains *why* we
 * had to restart — not just that we did. When the user sees "limpou:
 * whatsapp" repeatedly across incidents, they know the source of the
 * dirty config writes is something they need to fix (e.g. another
 * product writing to openclaw.json).
 */
function formatSweepNote(sweep: SweepResult | undefined): string {
  if (!sweep || !sweep.ran) return "";
  const cleaned: string[] = [];
  if (sweep.changedTelegram) cleaned.push("telegram");
  if (sweep.changedWhatsapp) cleaned.push("whatsapp");
  if (sweep.changedGatewayToolsAllow) cleaned.push("gateway.tools.allow");
  if (sweep.changedPluginsEnabled?.length > 0) {
    cleaned.push(`plugins.enabled (${sweep.changedPluginsEnabled.join("+")})`);
  }
  if (sweep.changedWhatsappChannelDefaults) cleaned.push("channels.whatsapp defaults");
  if (cleaned.length === 0) return "";
  return ` Antes disso o sweep removeu campos inválidos em: ${cleaned.join(", ")}.`;
}

const INCIDENTS_DIR = path.join(process.cwd(), "data", "incidents");

const TICK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_TICK_GAP_MS = 30_000;          // refuse to re-run within 30s of a manual call
const THROTTLE_MS = 30 * 60 * 1000;      // 30 min per check_id

// ─── Auto-restart watchdog ──────────────────────────────────────────────
// When the gateway check transitions to "fail" the monitor tries to bring
// it back without user intervention. Bounded attempts + cooldown so we
// don't thrash if the daemon is fundamentally broken (the user still gets
// the bell notification and can investigate manually).
const AUTO_RESTART_WINDOW_MS = 30 * 60 * 1000; // attempts only count inside a rolling 30-min window
const AUTO_RESTART_MAX_ATTEMPTS = 3;
const AUTO_RESTART_COOLDOWN_MS = 5 * 60 * 1000; // wait 5 min between attempts; tick is 2 min

// ─── Stuck-poller detection ─────────────────────────────────────────────
// pending_update_count growing across consecutive ticks while the gateway
// process is alive means the Telegram adapter inside the gateway has hung
// (typical cause: 409 Conflict recovery loop, NAT/socket timeout on the
// long-poll). Require N consecutive *growing* ticks before firing so
// active conversations (where pending oscillates around 1) don't trigger
// false-positive restarts. Tightened on 2026-05-29 after we observed the
// watchdog killing the gateway during active chat: pending=1 for two ticks
// was enough to fire under the old threshold, but pending=1 is the normal
// steady state for a single in-flight message.
const STUCK_POLLER_MIN_PENDING = 3;       // ignore light traffic ticks
const STUCK_POLLER_CONSECUTIVE = 3;       // 3 ticks = 6 minutes of strictly-growing backlog
const STUCK_POLLER_QUIET_MS = 10 * 60 * 1000; // re-arm: wait 10 min after a stuck-restart before re-flagging

interface CheckMemory {
  /** Last known status for this check id. */
  status: DiagnosticCheck["status"];
  /** Last time we notified the bell about this check breaking. */
  lastNotifiedAt: number;
}

interface PollerMemory {
  /** pending_update_count last seen for this account. */
  lastPending: number;
  /** Consecutive ticks where pending stayed non-zero AND did not shrink. */
  consecutiveNonDraining: number;
  /** Timestamp of the last stuck-poller restart, to debounce re-arm. */
  lastStuckRestartAt: number;
}

interface MonitorState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  lastTickAt: number;
  lastDiagnose: DiagnoseResponse | null;
  /** Per-check memory keyed by check.id. */
  checkMem: Map<string, CheckMemory>;
  /** Per-account memory keyed by accountId, for stuck-poller detection. */
  pollerMem: Map<string, PollerMemory>;
  /** Did we already notify about the global degraded state? Resets on recovery. */
  degradedNotifiedAt: number;
  /** Timestamps of recent auto-restart attempts; pruned to AUTO_RESTART_WINDOW_MS. */
  restartAttempts: number[];
  /** Did we tell the user the circuit broke (gave up auto-restart)? Reset on success. */
  circuitOpenNotifiedAt: number;
  /** True while an auto-restart is in flight; prevents concurrent attempts across ticks. */
  restartInFlight: boolean;
}

const state: MonitorState = {
  started: false,
  timer: null,
  lastTickAt: 0,
  lastDiagnose: null,
  checkMem: new Map(),
  pollerMem: new Map(),
  degradedNotifiedAt: 0,
  restartAttempts: [],
  circuitOpenNotifiedAt: 0,
  restartInFlight: false,
};

function isProblem(s: DiagnosticCheck["status"]): boolean {
  return s === "fail" || s === "warn";
}

function severity(s: DiagnosticCheck["status"]): number {
  if (s === "fail") return 2;
  if (s === "warn") return 1;
  return 0;
}

async function tick(reason: "scheduled" | "manual" = "scheduled"): Promise<DiagnoseResponse | null> {
  const now = Date.now();
  if (now - state.lastTickAt < MIN_TICK_GAP_MS && reason === "scheduled") {
    // Another caller ran us very recently; skip to avoid hammering Bot API
    return state.lastDiagnose;
  }
  state.lastTickAt = now;

  let report: DiagnoseResponse;
  try {
    report = await runDiagnose({ sendTest: false });
  } catch (err) {
    console.warn("[health-monitor] diagnose failed:", err);
    return state.lastDiagnose;
  }

  const prev = state.lastDiagnose;
  state.lastDiagnose = report;

  // ─── Per-check transitions ──────────────────────────────────────────────
  for (const c of report.checks) {
    const mem = state.checkMem.get(c.id);
    const wasProblem = mem ? isProblem(mem.status) : false;
    const isNowProblem = isProblem(c.status);

    if (isNowProblem && !wasProblem) {
      // OK → broken. Notify (subject to throttle).
      const lastNotifiedAt = mem?.lastNotifiedAt ?? 0;
      if (now - lastNotifiedAt > THROTTLE_MS) {
        const isFail = c.status === "fail";
        await safeAddNotification(
          isFail ? "⚠️ Integração caiu" : "ℹ️ Atenção numa integração",
          `${c.label} — ${c.detail}`,
          isFail ? "error" : "warning",
          "/settings?openDoctor=1",
          { checkId: c.id, severity: c.status, category: c.category, fix: c.fix?.action },
        );
        state.checkMem.set(c.id, { status: c.status, lastNotifiedAt: now });
      } else {
        // Update status but keep throttle timestamp
        state.checkMem.set(c.id, {
          status: c.status,
          lastNotifiedAt: lastNotifiedAt,
        });
      }
    } else if (!isNowProblem && wasProblem) {
      // Broken → OK. Notify recovery (no throttle — recovery is rare).
      await safeAddNotification(
        "✅ Integração recuperada",
        `${c.label} voltou ao normal.`,
        "success",
        undefined,
        { checkId: c.id, category: c.category },
      );
      state.checkMem.set(c.id, { status: c.status, lastNotifiedAt: now });
    } else {
      // No transition; just remember the current status
      state.checkMem.set(c.id, {
        status: c.status,
        lastNotifiedAt: mem?.lastNotifiedAt ?? 0,
      });
    }
  }

  // ─── Auto-restart watchdog ──────────────────────────────────────────────
  // Skip on the very first tick — give the gateway a full cycle to settle
  // before assuming it's broken (avoids racing a still-booting daemon).
  if (prev !== null) {
    const gatewayCheck = report.checks.find((c) => c.id === "gateway");
    if (gatewayCheck?.status === "fail") {
      await maybeAutoRestartGateway(now);
    } else if (gatewayCheck?.status === "pass") {
      // Gateway healthy → forget any "circuit open" notification state so the
      // next outage gets a fresh budget.
      if (state.restartAttempts.length > 0 || state.circuitOpenNotifiedAt > 0) {
        state.restartAttempts = [];
        state.circuitOpenNotifiedAt = 0;
      }
      // Gateway alive AND poller drained? Reset stuck-poller memory so a
      // healthy stretch clears the bad streak.
      for (const r of report.routing) {
        const mem = state.pollerMem.get(r.accountId);
        if (mem && r.pendingUpdates === 0) {
          mem.consecutiveNonDraining = 0;
          mem.lastPending = 0;
        }
      }
      await maybeAutoRestartStuckPoller(now, report);
    }
  }

  // ─── Global headline transition ─────────────────────────────────────────
  // Single "global" notification when overall health crosses thresholds, so
  // the user sees a single summary instead of just a flood of per-check
  // alerts. Only fires once per degraded episode.
  const prevSev = prev ? worstSeverity(prev.checks) : 0;
  const curSev = worstSeverity(report.checks);
  if (curSev >= 1 && prevSev === 0 && now - state.degradedNotifiedAt > THROTTLE_MS) {
    state.degradedNotifiedAt = now;
    await safeAddNotification(
      curSev === 2 ? "🚨 Algo quebrou no Jarvis" : "👀 Algo merece atenção no Jarvis",
      `${report.summary.headline}. Clica em "Diagnosticar" pra ver o que está acontecendo e aplicar os fixes.`,
      curSev === 2 ? "error" : "warning",
      "/settings?openDoctor=1",
      { headline: report.summary.headline, summary: report.summary },
    );
  } else if (curSev === 0 && prevSev > 0) {
    state.degradedNotifiedAt = 0;
    await safeAddNotification(
      "🟢 Tudo voltou ao normal",
      "A integração Telegram + OpenClaw está saudável de novo.",
      "success",
      undefined,
      { summary: report.summary },
    );
  }

  return report;
}

/**
 * Detects "gateway alive but Telegram poller hung" via pending_update_count
 * that fails to drain across N consecutive ticks, then triggers a gateway
 * restart. Different code path from maybeAutoRestartGateway (which handles
 * "gateway process dead") because the symptom and the restart strategy
 * differ — here we know the process is alive, so we restart it instead of
 * trying to bootstrap from nothing.
 */
async function maybeAutoRestartStuckPoller(
  now: number,
  report: DiagnoseResponse,
): Promise<void> {
  if (state.restartInFlight) return;
  if (report.routing.length === 0) return;

  const stuck: string[] = [];

  for (const r of report.routing) {
    // Webhook is set? Polling isn't even running — skip. Diagnose already
    // raised a check for it.
    if (r.webhookSet) continue;

    const mem = state.pollerMem.get(r.accountId) ?? {
      lastPending: 0,
      consecutiveNonDraining: 0,
      lastStuckRestartAt: 0,
    };

    // Strictly growing AND above threshold. The previous "growing-or-equal"
    // rule mistook normal conversation rhythm (where pending stays at 1
    // while the gateway processes each message inside a tick) for a stuck
    // poller. A truly stuck poller will see pending climb monotonically
    // because messages arrive but no offset commit drains them.
    if (r.pendingUpdates >= STUCK_POLLER_MIN_PENDING && r.pendingUpdates > mem.lastPending) {
      mem.consecutiveNonDraining++;
    } else {
      mem.consecutiveNonDraining = 0;
    }
    mem.lastPending = r.pendingUpdates;
    state.pollerMem.set(r.accountId, mem);

    // Debounce: if we restarted recently for this account, wait the
    // re-arm window before treating it as stuck again.
    const recentlyRestarted = now - mem.lastStuckRestartAt < STUCK_POLLER_QUIET_MS;
    if (mem.consecutiveNonDraining >= STUCK_POLLER_CONSECUTIVE && !recentlyRestarted) {
      stuck.push(r.accountId);
    }
  }

  if (stuck.length === 0) return;

  // Reuse the same circuit-breaker as the gateway-dead watchdog so total
  // restart attempts stay bounded regardless of the trigger reason.
  state.restartAttempts = state.restartAttempts.filter(
    (t) => now - t < AUTO_RESTART_WINDOW_MS,
  );
  if (state.restartAttempts.length >= AUTO_RESTART_MAX_ATTEMPTS) {
    if (now - state.circuitOpenNotifiedAt > AUTO_RESTART_WINDOW_MS) {
      state.circuitOpenNotifiedAt = now;
      await safeAddNotification(
        "🛑 Auto-recuperação do Telegram pausada",
        `Tentei reiniciar o gateway ${AUTO_RESTART_MAX_ATTEMPTS}x em 30min e o polling do Telegram continua travando. Abre o Doctor pra investigar.`,
        "error",
        "/settings?openDoctor=1",
        { attempts: state.restartAttempts.length, reason: "stuck-poller" },
      );
    }
    return;
  }
  const lastAttempt = state.restartAttempts[state.restartAttempts.length - 1] ?? 0;
  if (lastAttempt > 0 && now - lastAttempt < AUTO_RESTART_COOLDOWN_MS) return;

  state.restartAttempts.push(now);
  state.restartInFlight = true;

  // Snapshot logs BEFORE restart so we capture the broken state for forensics.
  const accountsLabel = stuck.join(", ");
  await captureIncidentSnapshot(`stuck-poller-${stuck[0]}`, {
    accounts: stuck,
    routing: report.routing,
  });

  try {
    const r = await restartGateway();
    for (const accountId of stuck) {
      const mem = state.pollerMem.get(accountId);
      if (mem) {
        mem.lastStuckRestartAt = now;
        mem.consecutiveNonDraining = 0;
        mem.lastPending = 0;
      }
    }
    const sweepNote = formatSweepNote(r.sweep);
    if (r.success) {
      await safeAddNotification(
        "🔄 Telegram reanimado automaticamente",
        `Polling travado em ${accountsLabel} — reiniciei o gateway via ${r.runtime}.${sweepNote} O bot deve voltar em alguns segundos.`,
        "success",
        "/settings?openDoctor=1",
        {
          runtime: r.runtime,
          attempt: state.restartAttempts.length,
          reason: "stuck-poller",
          accounts: stuck,
          sweep: r.sweep,
        },
      );
    } else {
      await safeAddNotification(
        "⚠️ Falha ao reanimar Telegram",
        `Polling travado em ${accountsLabel} mas o restart automático falhou (${r.runtime}).${sweepNote} Abre o Doctor pra investigar.`,
        "error",
        "/settings?openDoctor=1",
        {
          runtime: r.runtime,
          output: r.output.slice(0, 500),
          reason: "stuck-poller",
          sweep: r.sweep,
        },
      );
      console.warn(
        `[health-monitor] stuck-poller restart falhou (${r.runtime}):\n${r.output}`,
      );
    }
  } catch (err) {
    console.warn("[health-monitor] stuck-poller restart threw:", err);
  } finally {
    state.restartInFlight = false;
  }
}

async function maybeAutoRestartGateway(now: number): Promise<void> {
  if (state.restartInFlight) return;

  // Prune attempts outside the rolling window
  state.restartAttempts = state.restartAttempts.filter(
    (t) => now - t < AUTO_RESTART_WINDOW_MS,
  );

  // Circuit breaker — too many recent attempts. Notify once and give up
  // until the window slides forward.
  if (state.restartAttempts.length >= AUTO_RESTART_MAX_ATTEMPTS) {
    if (now - state.circuitOpenNotifiedAt > AUTO_RESTART_WINDOW_MS) {
      state.circuitOpenNotifiedAt = now;
      await safeAddNotification(
        "🛑 Auto-recuperação do gateway pausada",
        `Tentei reiniciar ${AUTO_RESTART_MAX_ATTEMPTS}x em 30min e o gateway continua caindo. Abre o Doctor e investiga (provavelmente erro de config ou crash recorrente).`,
        "error",
        "/settings?openDoctor=1",
        { attempts: state.restartAttempts.length },
      );
    }
    return;
  }

  // Cooldown between attempts so we don't hammer the daemon while it boots
  const lastAttempt = state.restartAttempts[state.restartAttempts.length - 1] ?? 0;
  if (lastAttempt > 0 && now - lastAttempt < AUTO_RESTART_COOLDOWN_MS) return;

  state.restartAttempts.push(now);
  state.restartInFlight = true;
  await captureIncidentSnapshot("gateway-dead", {
    restartAttempts: state.restartAttempts.length,
  });
  try {
    const r = await startGateway();
    const sweepNote = formatSweepNote(r.sweep);
    if (r.success) {
      await safeAddNotification(
        "🤖 Gateway reanimado automaticamente",
        `Gateway estava caído — iniciei de novo via ${r.runtime}.${sweepNote} O Telegram deve voltar em alguns segundos.`,
        "success",
        "/settings?openDoctor=1",
        {
          runtime: r.runtime,
          attempt: state.restartAttempts.length,
          sweep: r.sweep,
        },
      );
    } else {
      await safeAddNotification(
        "⚠️ Restart automático do gateway falhou",
        `Tentativa ${state.restartAttempts.length}/${AUTO_RESTART_MAX_ATTEMPTS} via ${r.runtime} não voltou.${sweepNote} Veja o incident log mais recente.`,
        "error",
        "/settings?openDoctor=1",
        {
          runtime: r.runtime,
          output: r.output.slice(0, 500),
          attempt: state.restartAttempts.length,
          sweep: r.sweep,
        },
      );
      console.warn(
        `[health-monitor] auto-restart tentativa ${state.restartAttempts.length}/${AUTO_RESTART_MAX_ATTEMPTS} falhou (${r.runtime}):\n${r.output}`,
      );
    }
  } catch (err) {
    console.warn("[health-monitor] auto-restart threw:", err);
  } finally {
    state.restartInFlight = false;
  }
}

function worstSeverity(checks: DiagnosticCheck[]): number {
  let s = 0;
  for (const c of checks) {
    const cs = severity(c.status);
    if (cs > s) s = cs;
  }
  return s;
}

/**
 * Best-effort log capture before an auto-restart. Writes a single file under
 * data/incidents/ so post-mortem can find the gateway state at the moment
 * the watchdog decided something was wrong. Never throws — if disk/perms
 * fail we just move on; the restart itself is the user-visible action.
 */
async function captureIncidentSnapshot(
  reason: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(INCIDENTS_DIR, { recursive: true });
    const logs = await gatewayLogs({ lines: 300 }).catch(() => null);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(INCIDENTS_DIR, `${ts}-${reason}.log`);
    const header = [
      `# Incident: ${reason}`,
      `# At: ${new Date().toISOString()}`,
      `# Context: ${JSON.stringify(context)}`,
      `# Gateway logs source: ${logs?.source ?? "n/d"}`,
      "",
      "",
    ].join("\n");
    await writeFile(file, header + (logs?.output ?? "(sem logs disponíveis)\n"));
  } catch (err) {
    console.warn("[health-monitor] incident snapshot failed:", err);
  }
}

async function safeAddNotification(
  title: string,
  message: string,
  type: "info" | "success" | "warning" | "error",
  link?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await addNotification(title, message, type, link, metadata);
  } catch (err) {
    console.warn("[health-monitor] addNotification failed:", err);
  }
}

export function startHealthMonitor(): void {
  if (state.started) return;
  state.started = true;
  // Run once shortly after boot to baseline current state — but delay 8s so
  // we don't pile onto the dashboard's cold-start fetches.
  setTimeout(() => {
    void tick("scheduled");
  }, 8000);
  state.timer = setInterval(() => {
    void tick("scheduled");
  }, TICK_INTERVAL_MS);
  // Don't block process shutdown
  if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
}

/** Force an immediate health check. Used by the doctor UI after fixes. */
export async function triggerHealthCheck(): Promise<DiagnoseResponse | null> {
  return tick("manual");
}

/** Last cached report — synchronous, returns null until first tick lands. */
export function getLastHealth(): DiagnoseResponse | null {
  return state.lastDiagnose;
}

/**
 * Snapshot of the auto-restart watchdog for the diagnose endpoint. We
 * expose the raw attempt timestamps + circuit-breaker fields so the user
 * can see how close we are to "giving up" without having to read code.
 */
export function getWatchdogState(): {
  started: boolean;
  lastTickAt: number;
  restartAttempts: number[];
  restartAttemptsCount: number;
  restartLimit: number;
  windowMs: number;
  cooldownMs: number;
  circuitOpen: boolean;
  circuitOpenNotifiedAt: number;
  restartInFlight: boolean;
} {
  const now = Date.now();
  const recentAttempts = state.restartAttempts.filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
  return {
    started: state.started,
    lastTickAt: state.lastTickAt,
    restartAttempts: state.restartAttempts,
    restartAttemptsCount: recentAttempts.length,
    restartLimit: AUTO_RESTART_MAX_ATTEMPTS,
    windowMs: AUTO_RESTART_WINDOW_MS,
    cooldownMs: AUTO_RESTART_COOLDOWN_MS,
    circuitOpen: recentAttempts.length >= AUTO_RESTART_MAX_ATTEMPTS,
    circuitOpenNotifiedAt: state.circuitOpenNotifiedAt,
    restartInFlight: state.restartInFlight,
  };
}
