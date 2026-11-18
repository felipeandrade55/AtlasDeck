/**
 * Liveness of the atlasdeck-bridge gateway plugin. Kept in its own tiny
 * module so the extractor and the ingest path can both use it without
 * importing each other.
 */
import { getSettingValue, setSettingValue } from "@/lib/memory-db";

export const BRIDGE_LAST_SEEN_KEY = "bridge_plugin_last_seen";

export function markBridgeSeen(): void {
  try {
    setSettingValue(BRIDGE_LAST_SEEN_KEY, new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

/** True when the bridge plugin talked to us in the last `withinMs`. */
export function isBridgeActive(withinMs = 24 * 3600_000): boolean {
  const last = getSettingValue(BRIDGE_LAST_SEEN_KEY);
  if (!last) return false;
  const ms = Date.parse(last);
  return Number.isFinite(ms) && Date.now() - ms < withinMs;
}

export function bridgeLastSeen(): string | null {
  return getSettingValue(BRIDGE_LAST_SEEN_KEY);
}
