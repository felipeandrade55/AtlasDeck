/**
 * Ingest endpoint for remote VPS agents.
 *
 * Auth: per-host token in the `x-vps-token` header (distinct from the
 * single shared `x-openclaw-token`). The host is resolved BY the token hash;
 * an unknown token is rejected with 401 and NO host is auto-created — only
 * tokens enrolled manually in the UI are accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getHostByToken,
  touchHost,
  updateSnapshot,
  type VpsSnapshot,
} from '@/lib/vps-db';
import {
  insertSamples,
  runRollup,
  VPS_METRIC_KEYS,
  type MetricSample,
  type VpsMetricKey,
} from '@/lib/vps-metrics-db';
import { evaluateResourceAlerts, type IngestSample } from '@/lib/vps-alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VPS_TOKEN_HEADER = 'x-vps-token';
const MAX_SAMPLES = 500;
const TS_SKEW_MS = 10 * 60 * 1000;

interface IngestBody {
  agentVersion?: string;
  hostname?: string;
  os?: string;
  samples?: Array<{
    ts?: number;
    metrics?: Record<string, number>;
    processes?: Array<{ pid?: number; name: string; cpu: number; memPct: number; cmd?: string }>;
    services?: Array<{ type: string; name: string; active: boolean; detail?: string }>;
    disks?: Array<{ mount: string; totalGb: number; usedGb: number; pct: number }>;
    docker?: {
      installed: boolean;
      running?: boolean;
      containers?: Array<Record<string, unknown>>;
    };
  }>;
}

export async function POST(request: NextRequest) {
  const token = request.headers.get(VPS_TOKEN_HEADER);
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 });
  }
  const host = getHostByToken(token);
  if (!host) {
    return NextResponse.json({ error: 'Unknown token' }, { status: 401 });
  }

  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const samples = body.samples;
  if (!Array.isArray(samples)) {
    return NextResponse.json({ error: 'samples must be an array' }, { status: 400 });
  }
  if (samples.length > MAX_SAMPLES) {
    return NextResponse.json({ error: 'too many samples' }, { status: 413 });
  }

  const serverNow = Date.now();
  let accepted = 0;

  for (const s of samples) {
    try {
      const agentTs = typeof s.ts === 'number' ? s.ts : serverNow;
      // Clamp clock-skewed timestamps for the series PK; keep agent ts in snapshot.
      const seriesTs = Math.abs(agentTs - serverNow) > TS_SKEW_MS ? serverNow : agentTs;

      const numeric: MetricSample[] = [];
      const m = s.metrics || {};
      for (const key of VPS_METRIC_KEYS) {
        const v = m[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          numeric.push({ metric: key as VpsMetricKey, value: v });
        }
      }
      if (numeric.length > 0) insertSamples(host.vps_id, seriesTs, numeric);
      accepted += 1;
    } catch (err) {
      // Skip poison samples but keep going so the agent's spool drains.
      console.warn('[vps/ingest] sample skipped:', err);
    }
  }

  // Latest sample drives the snapshot + alerts.
  const latest = samples[samples.length - 1];
  if (latest) {
    const snapshot: VpsSnapshot = {
      reportedAtMs: serverNow,
      agentTs: typeof latest.ts === 'number' ? latest.ts : serverNow,
      metrics: latest.metrics || {},
      processes: latest.processes?.map((p) => ({
        pid: p.pid ?? 0,
        name: p.name,
        cpu: p.cpu,
        memPct: p.memPct,
        cmd: p.cmd,
      })),
      services: latest.services?.map((sv) => ({
        type: sv.type === 'docker' ? 'docker' : 'systemd',
        name: sv.name,
        active: sv.active,
        detail: sv.detail,
      })),
      disks: latest.disks,
      docker: normalizeDocker(latest.docker),
      loadAvg:
        latest.metrics &&
        [latest.metrics.load1, latest.metrics.load5, latest.metrics.load15].every(
          (n) => typeof n === 'number'
        )
          ? [latest.metrics.load1, latest.metrics.load5, latest.metrics.load15]
          : undefined,
      uptimeSec: latest.metrics?.uptime_sec,
    };
    updateSnapshot(host.vps_id, snapshot);

    touchHost(host.vps_id, {
      hostname: body.hostname ?? null,
      os: body.os ?? null,
      agent_version: body.agentVersion ?? null,
      lastSeenMs: serverNow,
      status: 'online',
    });

    // Roll up immediately so the chart populates within one batch.
    try {
      runRollup();
    } catch (err) {
      console.warn('[vps/ingest] rollup failed:', err);
    }

    // Re-read the host so alerts see the just-updated hostname/status.
    const ingestSample: IngestSample = {
      metrics: latest.metrics,
      processes: latest.processes,
      services: latest.services,
      docker: normalizeDocker(latest.docker),
    };
    try {
      await evaluateResourceAlerts({ ...host, status: 'online' }, ingestSample);
    } catch (err) {
      console.warn('[vps/ingest] alert eval failed:', err);
    }
  }

  return NextResponse.json({ ok: true, accepted });
}

type NormalizedDocker = {
  installed: boolean;
  running?: boolean;
  containers?: Array<{
    name: string;
    image?: string;
    state: string;
    status?: string;
    cpu?: number;
    memPct?: number;
    memMb?: number;
    restarts?: number;
  }>;
};

function normalizeDocker(
  docker: { installed: boolean; running?: boolean; containers?: Array<Record<string, unknown>> } | undefined
): NormalizedDocker | undefined {
  if (!docker || typeof docker !== 'object') return undefined;
  const d = docker;
  if (!d.installed) return { installed: false };
  return {
    installed: true,
    running: !!d.running,
    containers: (d.containers || []).map((c) => ({
      name: String(c.name ?? ''),
      image: c.image != null ? String(c.image) : undefined,
      state: String(c.state ?? 'unknown'),
      status: c.status != null ? String(c.status) : undefined,
      cpu: typeof c.cpu === 'number' ? c.cpu : undefined,
      memPct: typeof c.memPct === 'number' ? c.memPct : undefined,
      memMb: typeof c.memMb === 'number' ? c.memMb : undefined,
      restarts: typeof c.restarts === 'number' ? c.restarts : undefined,
    })),
  };
}
