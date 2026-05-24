/**
 * Client-side helper to trigger an OpenClaw gateway restart from the dashboard.
 * Used by /agents and OpenClawDefaultsCard after saving a model change so the
 * gateway picks up the new openclaw.json without a manual restart step.
 *
 * Backed by POST /api/recovery/action with `action: "gateway-restart"`, which
 * uses the adaptive systemd → PM2 → /proc respawn chain in gateway-control.ts.
 */
export interface ClientRestartResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export async function restartGatewayClient(): Promise<ClientRestartResult> {
  const t0 = Date.now();
  try {
    const res = await fetch("/api/recovery/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "gateway-restart" }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      success: !!data.success,
      output: typeof data.output === "string" ? data.output : "",
      error: typeof data.error === "string" ? data.error : undefined,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      success: false,
      output: "",
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
    };
  }
}

/** Local storage key for the "auto-restart after save" preference. */
export const AUTO_RESTART_PREF_KEY = "atlasdeck.openclaw.auto-restart";

export function getAutoRestartPref(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(AUTO_RESTART_PREF_KEY);
  return v === null ? true : v === "true";
}

export function setAutoRestartPref(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTO_RESTART_PREF_KEY, String(value));
}
