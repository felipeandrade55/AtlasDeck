/**
 * Background watchdog that turns the agent-load monitor into action.
 *
 * What it does:
 *   - Every `intervalMs`, snapshots the agent load from recent gateway logs.
 *   - If severity == "critical" and we haven't rotated in `cooldownMs`,
 *     rotates the active Telegram session via
 *     `rotateActiveTelegramSession({ triggeredBy: "auto-watchdog" })`.
 *
 * Why it's ON by default:
 *   The whole point of the feature is "user never has to think about it".
 *   The rotation primitive is safe (5s inactivity safety window, 5min
 *   cooldown between rotations, full activity log), and a stuck bot is
 *   a worse failure mode than a possibly-unnecessary rotation. Disable
 *   with env `AGENT_LOAD_AUTO_ROTATE=off` or the toggle in the diagnose
 *   UI if it ever misbehaves.
 *
 * State is in-memory only: a dashboard restart clears the cooldown,
 * which is acceptable because cold-start latency (Next.js + DB) is
 * always > 5s, well above any rotation cadence we'd realistically use.
 */
import { gatewayLogs } from "./gateway-control";
import { snapshotAgentLoad, type AgentLoadSnapshot } from "./agent-load-monitor";
import { rotateActiveTelegramSession } from "./telegram-session-rotator";
import { logActivity } from "./activities-db";

interface WatchdogState {
  started: boolean;
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  lastTickAt: number;
  lastSnapshot: AgentLoadSnapshot | null;
  rotationsCount: number;
  lastRotationAt: number;
  lastRotationReason: string | null;
  lastError: string | null;
}

const state: WatchdogState = {
  started: false,
  enabled: false,
  intervalMs: 60_000,
  cooldownMs: 5 * 60_000,
  lastTickAt: 0,
  lastSnapshot: null,
  rotationsCount: 0,
  lastRotationAt: 0,
  lastRotationReason: null,
  lastError: null,
};

let timer: NodeJS.Timeout | null = null;

/**
 * Default: ON. Disable explicitly with `AGENT_LOAD_AUTO_ROTATE=off|0|false`.
 * Any other value (including unset) keeps auto-rotation enabled so the
 * "zero friction" promise survives a fresh install with no env tweaks.
 */
function envEnabled(): boolean {
  const raw = (process.env.AGENT_LOAD_AUTO_ROTATE || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return false;
  return true;
}

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();
  try {
    const logs = await gatewayLogs({ lines: 300, errorsOnly: false }).catch(
      () => null,
    );
    const snap = snapshotAgentLoad(logs?.output ?? null);
    state.lastSnapshot = snap;

    if (!state.enabled) return;
    if (snap.severity !== "critical") return;

    const sinceLast = Date.now() - state.lastRotationAt;
    if (state.lastRotationAt > 0 && sinceLast < state.cooldownMs) return;

    // Critical + cooldown clear → rotate.
    const result = await rotateActiveTelegramSession({
      triggeredBy: "auto-watchdog",
    });
    if (result.rotated) {
      state.rotationsCount += 1;
      state.lastRotationAt = Date.now();
      state.lastRotationReason = snap.hint;
      state.lastError = null;
    } else {
      // Not an error per se — could be safety window. Surface it in state
      // so the diagnose card can show "skipped: <reason>".
      state.lastError = `rotation skipped: ${result.reason}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    logActivity(
      "command",
      "Agent-load watchdog tick falhou",
      "error",
      {
        metadata: { action: "agent-load-watchdog-tick", error: msg },
      },
    );
  }
}

export function startAgentLoadWatchdog(opts?: {
  enabled?: boolean;
  intervalMs?: number;
  cooldownMs?: number;
}): void {
  if (state.started) return;
  state.started = true;
  state.enabled = opts?.enabled ?? envEnabled();
  if (opts?.intervalMs) state.intervalMs = opts.intervalMs;
  if (opts?.cooldownMs) state.cooldownMs = opts.cooldownMs;

  // Run an immediate tick so the diagnose card has data on first paint
  // instead of waiting `intervalMs` for the first snapshot.
  void tick();
  timer = setInterval(() => {
    void tick();
  }, state.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Toggle auto-rotation on/off at runtime. The watchdog keeps polling
 * either way — disabling only suppresses the rotation action so the UI
 * still shows current load.
 */
export function setAgentLoadAutoRotate(enabled: boolean): void {
  state.enabled = enabled;
  logActivity(
    "command",
    `Auto-rotação de sessão Telegram ${enabled ? "ATIVADA" : "DESATIVADA"}`,
    "success",
    { metadata: { action: "agent-load-auto-rotate-toggle", enabled } },
  );
}

export function getAgentLoadWatchdogState(): Readonly<WatchdogState> {
  return state;
}

/** Force an immediate tick. Used by the manual refresh button. */
export function triggerAgentLoadTick(): Promise<void> {
  return tick();
}
