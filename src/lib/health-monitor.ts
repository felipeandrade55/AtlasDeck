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
import { addNotification } from "./notifications";
import { runDiagnose, type DiagnosticCheck, type DiagnoseResponse } from "./telegram-diagnostic";

const TICK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_TICK_GAP_MS = 30_000;          // refuse to re-run within 30s of a manual call
const THROTTLE_MS = 30 * 60 * 1000;      // 30 min per check_id

interface CheckMemory {
  /** Last known status for this check id. */
  status: DiagnosticCheck["status"];
  /** Last time we notified the bell about this check breaking. */
  lastNotifiedAt: number;
}

interface MonitorState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  lastTickAt: number;
  lastDiagnose: DiagnoseResponse | null;
  /** Per-check memory keyed by check.id. */
  checkMem: Map<string, CheckMemory>;
  /** Did we already notify about the global degraded state? Resets on recovery. */
  degradedNotifiedAt: number;
}

const state: MonitorState = {
  started: false,
  timer: null,
  lastTickAt: 0,
  lastDiagnose: null,
  checkMem: new Map(),
  degradedNotifiedAt: 0,
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

function worstSeverity(checks: DiagnosticCheck[]): number {
  let s = 0;
  for (const c of checks) {
    const cs = severity(c.status);
    if (cs > s) s = cs;
  }
  return s;
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
