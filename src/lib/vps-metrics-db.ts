/**
 * Time-series storage for REMOTE VPS metrics (CPU/RAM/Swap/Disk/Network/Load).
 *
 * Multi-tenant sibling of metrics-db.ts: same tiered downsampling, but every
 * row is keyed by `vps_id` so many hosts share one DB without contaminating
 * each other's min/max/avg buckets. A separate data/vps-metrics.db keeps the
 * self-monitoring DB (metrics.db) untouched.
 *
 *   raw  → 30s samples,  kept 6h    → powers the "3h" range
 *   1m   → 1-min  buckets, kept 72h → powers "12h" / "24h"
 *   5m   → 5-min  buckets, kept 7d  → powers "72h" / "7d"
 *   1h   → 1-hour buckets, kept 30d → powers "30d"
 *   1d   → 1-day  buckets, kept forever → powers ">30d"
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'vps-metrics.db');

export type VpsMetricKey =
  | 'cpu_usage'
  | 'ram_used_pct'
  | 'swap_used_pct'
  | 'disk_used_pct'
  | 'net_rx_mbps'
  | 'net_tx_mbps'
  | 'load1'
  | 'load5'
  | 'load15'
  | 'load1_per_core'
  | 'uptime_sec';

export const VPS_METRIC_KEYS: VpsMetricKey[] = [
  'cpu_usage',
  'ram_used_pct',
  'swap_used_pct',
  'disk_used_pct',
  'net_rx_mbps',
  'net_tx_mbps',
  'load1',
  'load5',
  'load15',
  'load1_per_core',
  'uptime_sec',
];

export type BucketKey = '1m' | '5m' | '1h' | '1d';

export type RangeKey = '3h' | '12h' | '24h' | '72h' | '7d' | '30d' | '90d' | '1y';

export interface AggPoint {
  ts: number;
  min: number;
  max: number;
  avg: number;
  samples: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const RAW_RETENTION_MS = 6 * HOUR;
const RETENTION_BY_BUCKET: Record<BucketKey, number> = {
  '1m': 72 * HOUR,
  '5m': 7 * DAY,
  '1h': 30 * DAY,
  '1d': 365 * 10 * DAY,
};

const BUCKET_SIZE: Record<BucketKey, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': HOUR,
  '1d': DAY,
};

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS vps_metrics_raw (
      vps_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (vps_id, metric, ts)
    );

    CREATE TABLE IF NOT EXISTS vps_metrics_agg (
      vps_id TEXT NOT NULL,
      bucket TEXT NOT NULL,
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      min REAL NOT NULL,
      max REAL NOT NULL,
      avg REAL NOT NULL,
      samples INTEGER NOT NULL,
      PRIMARY KEY (vps_id, bucket, metric, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_vps_agg_lookup
      ON vps_metrics_agg(vps_id, metric, bucket, ts DESC);

    CREATE INDEX IF NOT EXISTS idx_vps_raw_lookup
      ON vps_metrics_raw(vps_id, ts);
  `);

  return _db;
}

export interface MetricSample {
  metric: VpsMetricKey;
  value: number;
}

/** Insert a batch of samples for one host taken at the same instant. */
export function insertSamples(vpsId: string, ts: number, samples: MetricSample[]): void {
  if (samples.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO vps_metrics_raw (vps_id, ts, metric, value) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction((rows: MetricSample[]) => {
    for (const r of rows) stmt.run(vpsId, ts, r.metric, r.value);
  });
  tx(samples);
}

function bucketStart(ts: number, bucket: BucketKey): number {
  const size = BUCKET_SIZE[bucket];
  return Math.floor(ts / size) * size;
}

/**
 * Build any complete higher-tier buckets that don't exist yet, then prune
 * each tier past its retention window. Multi-tenant: the promote helpers
 * group by (vps_id, metric, bucket); the prune is by ts cutoff across all
 * hosts. Idempotent via INSERT OR IGNORE.
 */
export function runRollup(now: number = Date.now()): void {
  const db = getDb();

  promoteRawToBucket(db, '1m', now);
  promoteBucketCascade(db, '1m', '5m', now);
  promoteBucketCascade(db, '5m', '1h', now);
  promoteBucketCascade(db, '1h', '1d', now);

  db.prepare('DELETE FROM vps_metrics_raw WHERE ts < ?').run(now - RAW_RETENTION_MS);

  for (const bucket of Object.keys(RETENTION_BY_BUCKET) as BucketKey[]) {
    const cutoff = now - RETENTION_BY_BUCKET[bucket];
    db.prepare('DELETE FROM vps_metrics_agg WHERE bucket = ? AND ts < ?').run(bucket, cutoff);
  }
}

function promoteRawToBucket(
  db: Database.Database,
  bucket: BucketKey,
  now: number
): void {
  const size = BUCKET_SIZE[bucket];
  const currentBucketStart = Math.floor(now / size) * size;
  const rows = db
    .prepare('SELECT vps_id, ts, metric, value FROM vps_metrics_raw WHERE ts < ?')
    .all(currentBucketStart) as Array<{ vps_id: string; ts: number; metric: string; value: number }>;
  if (rows.length === 0) return;

  const buckets = new Map<
    string,
    { vps_id: string; bucket: number; metric: string; vals: number[] }
  >();
  for (const r of rows) {
    const b = bucketStart(r.ts, bucket);
    const key = `${r.vps_id}|${r.metric}|${b}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { vps_id: r.vps_id, bucket: b, metric: r.metric, vals: [] };
      buckets.set(key, entry);
    }
    entry.vals.push(r.value);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO vps_metrics_agg (vps_id, bucket, ts, metric, min, max, avg, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const entry of buckets.values()) {
      const min = Math.min(...entry.vals);
      const max = Math.max(...entry.vals);
      const sum = entry.vals.reduce((a, b) => a + b, 0);
      const avg = sum / entry.vals.length;
      insert.run(entry.vps_id, bucket, entry.bucket, entry.metric, min, max, avg, entry.vals.length);
    }
  });
  tx();
}

function promoteBucketCascade(
  db: Database.Database,
  from: BucketKey,
  to: BucketKey,
  now: number
): void {
  const toSize = BUCKET_SIZE[to];
  const currentToStart = Math.floor(now / toSize) * toSize;
  const rows = db
    .prepare(
      'SELECT vps_id, ts, metric, min, max, avg, samples FROM vps_metrics_agg WHERE bucket = ? AND ts < ?'
    )
    .all(from, currentToStart) as Array<{
    vps_id: string;
    ts: number;
    metric: string;
    min: number;
    max: number;
    avg: number;
    samples: number;
  }>;
  if (rows.length === 0) return;

  const buckets = new Map<
    string,
    {
      vps_id: string;
      bucket: number;
      metric: string;
      min: number;
      max: number;
      sum: number;
      samples: number;
    }
  >();
  for (const r of rows) {
    const b = bucketStart(r.ts, to);
    const key = `${r.vps_id}|${r.metric}|${b}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        vps_id: r.vps_id,
        bucket: b,
        metric: r.metric,
        min: r.min,
        max: r.max,
        sum: 0,
        samples: 0,
      };
      buckets.set(key, entry);
    }
    if (r.min < entry.min) entry.min = r.min;
    if (r.max > entry.max) entry.max = r.max;
    entry.sum += r.avg * r.samples;
    entry.samples += r.samples;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO vps_metrics_agg (vps_id, bucket, ts, metric, min, max, avg, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const entry of buckets.values()) {
      insert.run(
        entry.vps_id,
        to,
        entry.bucket,
        entry.metric,
        entry.min,
        entry.max,
        entry.sum / entry.samples,
        entry.samples
      );
    }
  });
  tx();
}

/** Pick the right tier for a given range, biasing toward enough resolution. */
export function pickBucket(range: RangeKey): { bucket: BucketKey | 'raw'; sinceMs: number } {
  switch (range) {
    case '3h':
      return { bucket: 'raw', sinceMs: 3 * HOUR };
    case '12h':
      return { bucket: '1m', sinceMs: 12 * HOUR };
    case '24h':
      return { bucket: '1m', sinceMs: 24 * HOUR };
    case '72h':
      return { bucket: '5m', sinceMs: 72 * HOUR };
    case '7d':
      return { bucket: '5m', sinceMs: 7 * DAY };
    case '30d':
      return { bucket: '1h', sinceMs: 30 * DAY };
    case '90d':
      return { bucket: '1d', sinceMs: 90 * DAY };
    case '1y':
      return { bucket: '1d', sinceMs: 365 * DAY };
  }
}

export interface SeriesResponse {
  range: RangeKey;
  bucket: BucketKey | 'raw';
  from: number;
  to: number;
  metrics: Partial<Record<VpsMetricKey, AggPoint[]>>;
}

export function querySeries(
  vpsId: string,
  range: RangeKey,
  metrics: VpsMetricKey[]
): SeriesResponse {
  const db = getDb();
  const now = Date.now();
  const { bucket, sinceMs } = pickBucket(range);
  const from = now - sinceMs;
  const out: Partial<Record<VpsMetricKey, AggPoint[]>> = {};

  for (const metric of metrics) {
    if (bucket === 'raw') {
      const rows = db
        .prepare(
          'SELECT ts, value FROM vps_metrics_raw WHERE vps_id = ? AND metric = ? AND ts >= ? ORDER BY ts ASC'
        )
        .all(vpsId, metric, from) as Array<{ ts: number; value: number }>;
      out[metric] = rows.map(r => ({
        ts: r.ts,
        min: r.value,
        max: r.value,
        avg: r.value,
        samples: 1,
      }));
    } else {
      const rows = db
        .prepare(
          'SELECT ts, min, max, avg, samples FROM vps_metrics_agg WHERE vps_id = ? AND metric = ? AND bucket = ? AND ts >= ? ORDER BY ts ASC'
        )
        .all(vpsId, metric, bucket, from) as Array<{
        ts: number;
        min: number;
        max: number;
        avg: number;
        samples: number;
      }>;
      out[metric] = rows;
    }
  }

  return { range, bucket, from, to: now, metrics: out };
}

/** Delete all metric rows for a host (called when the host is removed). */
export function deleteVpsMetrics(vpsId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM vps_metrics_raw WHERE vps_id = ?').run(vpsId);
  db.prepare('DELETE FROM vps_metrics_agg WHERE vps_id = ?').run(vpsId);
}
