/**
 * In-process job that flips VPS hosts to "offline" when their heartbeat
 * (last ingest) goes stale past the per-host offlineSec threshold, and fires
 * the offline/recovery alert via the shared alert engine.
 *
 * Boots from instrumentation.ts. Same idempotency/HMR-safety as
 * metrics-scheduler.ts (global flag). Kill-switch: VPS_MONITOR_DISABLED=1
 */
import { listHosts, setHostStatus, getHost } from '@/lib/vps-db';
import { evaluateHeartbeat } from '@/lib/vps-alerts';

const TICK_INTERVAL_MS = Number.parseInt(
  process.env.VPS_MONITOR_INTERVAL_MS || `${30 * 1000}`,
  10
);

type Globals = typeof globalThis & {
  __atlasVpsMonitorStarted?: boolean;
  __atlasVpsMonitorTimer?: NodeJS.Timeout;
};
const G = globalThis as Globals;

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const host of listHosts()) {
      if (host.status === 'pending') continue; // never alerted before first contact
      const offlineMs = (host.thresholds.offlineSec || 180) * 1000;
      const isOnline = !!host.last_seen_ms && now - host.last_seen_ms < offlineMs;

      if (!isOnline && host.status !== 'offline') {
        setHostStatus(host.vps_id, 'offline');
        await evaluateHeartbeat(host, false);
      } else if (isOnline && host.status === 'offline') {
        // Heartbeat is fresh again (ingest already set last_seen). Reflect it.
        setHostStatus(host.vps_id, 'online');
        const fresh = getHost(host.vps_id);
        if (fresh) await evaluateHeartbeat(fresh, true);
      }
    }
  } catch (err) {
    console.warn('[vps-health-monitor] tick failed:', err);
  } finally {
    ticking = false;
  }
}

export function startVpsHealthMonitor(): void {
  if (process.env.VPS_MONITOR_DISABLED === '1') return;
  if (G.__atlasVpsMonitorStarted) return;
  G.__atlasVpsMonitorStarted = true;

  G.__atlasVpsMonitorTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  G.__atlasVpsMonitorTimer.unref?.();

  // One delayed tick after boot so we baseline without racing startup.
  setTimeout(() => void tick(), 8 * 1000);

  console.log(`[vps-health-monitor] started (tick=${TICK_INTERVAL_MS}ms)`);
}

export function stopVpsHealthMonitor(): void {
  if (G.__atlasVpsMonitorTimer) {
    clearInterval(G.__atlasVpsMonitorTimer);
    G.__atlasVpsMonitorTimer = undefined;
  }
  G.__atlasVpsMonitorStarted = false;
}
