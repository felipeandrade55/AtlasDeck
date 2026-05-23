/**
 * In-process scheduler that samples hardware metrics every 30s and runs
 * tier rollups every 5 min. Boots from instrumentation.ts.
 *
 * Safe to no-op when running outside Node (NEXT_RUNTIME guard) and
 * resilient to dev HMR (global flag prevents double-init).
 *
 * Kill-switch: METRICS_SCHEDULER_DISABLED=1
 */
import si from 'systeminformation';
import os from 'os';
import { insertSamples, runRollup, type MetricSample } from '@/lib/metrics-db';

const SAMPLE_INTERVAL_MS = Number.parseInt(
  process.env.METRICS_SAMPLE_INTERVAL_MS || `${30 * 1000}`,
  10
);
const ROLLUP_INTERVAL_MS = Number.parseInt(
  process.env.METRICS_ROLLUP_INTERVAL_MS || `${5 * 60 * 1000}`,
  10
);

type Globals = typeof globalThis & {
  __atlasMetricsSchedulerStarted?: boolean;
  __atlasMetricsSampleTimer?: NodeJS.Timeout;
  __atlasMetricsRollupTimer?: NodeJS.Timeout;
};
const G = globalThis as Globals;

let sampling = false;
let rollingUp = false;
let firstSampleDone = false;

async function sample(): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    const [cpuLoad, mem, fs, net, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.cpuTemperature().catch(() => ({ main: 0 })),
    ]);

    // Disk: sum physical filesystems (mirror /api/system/monitor logic).
    let diskTotal = 0;
    let diskUsed = 0;
    for (const f of fs) {
      if (f.type !== 'squashfs' && f.type !== 'tmpfs' && f.type !== 'devtmpfs') {
        diskTotal += f.size;
        diskUsed += f.used;
      }
    }
    const diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

    // Net: sum non-loopback ifaces, convert to MB/s.
    let rx = 0;
    let tx = 0;
    for (const n of net) {
      if (n.iface !== 'lo') {
        rx += n.rx_sec || 0;
        tx += n.tx_sec || 0;
      }
    }
    const rxMbps = rx / 1024 / 1024;
    const txMbps = tx / 1024 / 1024;

    const ramPct = mem.total > 0 ? (mem.active / mem.total) * 100 : 0;
    const cpuPct = cpuLoad.currentLoad;
    const cpuTemp = (temp as { main?: number }).main ?? 0;

    // First sample after boot has bogus network deltas — drop it but
    // still record CPU/RAM/Disk so the chart starts populating.
    const samples: MetricSample[] = [
      { metric: 'cpu_usage', value: round(cpuPct) },
      { metric: 'ram_used_pct', value: round(ramPct) },
      { metric: 'disk_used_pct', value: round(diskPct) },
      { metric: 'cpu_temp', value: round(cpuTemp) },
    ];
    if (firstSampleDone) {
      samples.push({ metric: 'net_rx_mbps', value: round(rxMbps, 3) });
      samples.push({ metric: 'net_tx_mbps', value: round(txMbps, 3) });
    }
    firstSampleDone = true;

    insertSamples(Date.now(), samples);
  } catch (err) {
    console.warn('[metrics-scheduler] sample failed:', err);
  } finally {
    sampling = false;
  }
}

async function rollup(): Promise<void> {
  if (rollingUp) return;
  rollingUp = true;
  try {
    runRollup();
  } catch (err) {
    console.warn('[metrics-scheduler] rollup failed:', err);
  } finally {
    rollingUp = false;
  }
}

function round(n: number, digits = 1): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

export function startMetricsScheduler(): void {
  if (process.env.METRICS_SCHEDULER_DISABLED === '1') return;
  if (G.__atlasMetricsSchedulerStarted) return;
  G.__atlasMetricsSchedulerStarted = true;

  // Prime systeminformation network deltas, then start sampling.
  si.networkStats()
    .catch(() => undefined)
    .then(() => {
      void sample();
    });

  G.__atlasMetricsSampleTimer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  G.__atlasMetricsRollupTimer = setInterval(() => void rollup(), ROLLUP_INTERVAL_MS);

  // Run an initial rollup ~30s after boot so legacy data gets pruned.
  setTimeout(() => void rollup(), 30 * 1000);

  console.log(
    `[metrics-scheduler] started (sample=${SAMPLE_INTERVAL_MS}ms rollup=${ROLLUP_INTERVAL_MS}ms host=${os.hostname()})`
  );
}

export function stopMetricsScheduler(): void {
  if (G.__atlasMetricsSampleTimer) {
    clearInterval(G.__atlasMetricsSampleTimer);
    G.__atlasMetricsSampleTimer = undefined;
  }
  if (G.__atlasMetricsRollupTimer) {
    clearInterval(G.__atlasMetricsRollupTimer);
    G.__atlasMetricsRollupTimer = undefined;
  }
  G.__atlasMetricsSchedulerStarted = false;
}
