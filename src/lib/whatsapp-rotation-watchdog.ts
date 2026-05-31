/**
 * Background scheduler for WhatsApp session rotation. Ticks once a
 * minute; when the configured interval has elapsed since the last
 * rotation, calls `rotateActiveWhatsappSession({triggeredBy:"auto-watchdog"})`.
 *
 * Schedule-based, NOT threshold-based:
 *   The Telegram watchdog (`agent-load-watchdog`) rotates when severity
 *   reaches "critical" — it's reactive. This one is preventive: the
 *   user picks an interval ("every 24h") and we honor it. Both are
 *   valid models and they coexist on the same sessions dir without
 *   stepping on each other because each rotator only acts on sessions
 *   matching its own channel peek.
 *
 * State is in-memory only beyond the lastRotatedAt persisted in
 * `data/whatsapp-rotation-config.json`. A dashboard restart re-reads
 * the config and resumes from there — no scheduling drift.
 */
import { getWhatsappRotationConfig, markWhatsappRotated } from "./whatsapp-rotation-config";
import { rotateActiveWhatsappSession } from "./whatsapp-session-rotator";
import { logActivity } from "./activities-db";

interface WatchdogState {
  started: boolean;
  intervalMs: number;
  lastTickAt: number;
  rotationsCount: number;
  lastRotationAt: number;
  lastError: string | null;
}

const state: WatchdogState = {
  started: false,
  intervalMs: 60_000,
  lastTickAt: 0,
  rotationsCount: 0,
  lastRotationAt: 0,
  lastError: null,
};

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();
  try {
    const cfg = getWhatsappRotationConfig();
    if (!cfg.enabled) return;

    const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
    const elapsed = Date.now() - cfg.lastRotatedAt;
    if (elapsed < intervalMs) return;

    const result = await rotateActiveWhatsappSession({
      triggeredBy: "auto-watchdog",
    });
    if (result.rotated) {
      state.rotationsCount += 1;
      state.lastRotationAt = Date.now();
      markWhatsappRotated(state.lastRotationAt);
      state.lastError = null;
    } else {
      // Skipped (no active session, or inside safety window) — mark
      // anyway so we don't hammer the rotator every minute.
      markWhatsappRotated(Date.now());
      state.lastError = `rotation skipped: ${result.reason}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    logActivity(
      "command",
      "WhatsApp rotation watchdog tick falhou",
      "error",
      { metadata: { action: "whatsapp-rotation-watchdog-tick", error: msg } },
    );
  }
}

export function startWhatsappRotationWatchdog(): void {
  if (state.started) return;
  state.started = true;
  // Run one tick immediately so a freshly-saved config takes effect
  // without waiting up to a minute for the first interval.
  void tick();
  timer = setInterval(() => {
    void tick();
  }, state.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

export function getWhatsappRotationWatchdogState(): Readonly<WatchdogState> {
  return state;
}

/** Force an immediate tick. Used by the manual refresh button. */
export function triggerWhatsappRotationTick(): Promise<void> {
  return tick();
}
