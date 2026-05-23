/**
 * Time-series storage for hardware metrics (CPU/RAM/Disk/Network/Temp).
 *
 * Tiered downsampling so we keep recent data at high resolution and
 * collapse older data into min/max/avg buckets — long-term storage
 * stays tiny while we never lose the peaks.
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

const DB_PATH = path.join(process.cwd(), 'data', 'metrics.db');

export type MetricKey =
  | 'cpu_usage'
  | 'cpu_temp'
  | 'ram_used_pct'
  | 'disk_used_pct'
  | 'net_rx_mbps'
  | 'net_tx_mbps';

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
    CREATE TABLE IF NOT EXISTS metrics_raw (
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (metric, ts)
    );

    CREATE TABLE IF NOT EXISTS metrics_agg (
      bucket TEXT NOT NULL,
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      min REAL NOT NULL,
      max REAL NOT NULL,
      avg REAL NOT NULL,
      samples INTEGER NOT NULL,
      PRIMARY KEY (bucket, metric, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_agg_lookup
      ON metrics_agg(metric, bucket, ts DESC);

    CREATE INDEX IF NOT EXISTS idx_metrics_raw_ts
      ON metrics_raw(ts);
  `);

  return _db;
}

export interface MetricSample {
  metric: MetricKey;
  value: number;
}

/** Insert a batch of samples taken at the same instant. */
export function insertSamples(ts: number, samples: MetricSample[]): void {
  if (samples.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO metrics_raw (ts, metric, value) VALUES (?, ?, ?)'
  );
  const tx = db.transaction((rows: MetricSample[]) => {
    for (const r of rows) stmt.run(ts, r.metric, r.value);
  });
  tx(samples);
}

function bucketStart(ts: number, bucket: BucketKey): number {
  const size = BUCKET_SIZE[bucket];
  return Math.floor(ts / size) * size;
}

/**
 * Promote raw rows older than RAW_RETENTION_MS into 1m aggregates,
 * then cascade 1m→5m→1h→1d as each tier ages out of its retention window.
 * Idempotent: re-running with no new data is a no-op.
 */
export function runRollup(now: number = Date.now()): void {
  const db = getDb();

  // raw → 1m
  const rawCutoff = now - RAW_RETENTION_MS;
  const rawRows = db
    .prepare('SELECT ts, metric, value FROM metrics_raw WHERE ts < ?')
    .all(rawCutoff) as Array<{ ts: number; metric: string; value: number }>;

  if (rawRows.length > 0) {
    const buckets = new Map<string, { bucket: number; metric: string; vals: number[] }>();
    for (const r of rawRows) {
      const b = bucketStart(r.ts, '1m');
      const key = `${r.metric}|${b}`;
      let entry = buckets.get(key);
      if (!entry) {
        entry = { bucket: b, metric: r.metric, vals: [] };
        buckets.set(key, entry);
      }
      entry.vals.push(r.value);
    }
    upsertAgg(db, '1m', Array.from(buckets.values()));
    db.prepare('DELETE FROM metrics_raw WHERE ts < ?').run(rawCutoff);
  }

  // 1m → 5m, 5m → 1h, 1h → 1d
  cascadeAgg(db, '1m', '5m', now);
  cascadeAgg(db, '5m', '1h', now);
  cascadeAgg(db, '1h', '1d', now);

  // Prune each tier past its retention.
  for (const bucket of Object.keys(RETENTION_BY_BUCKET) as BucketKey[]) {
    const cutoff = now - RETENTION_BY_BUCKET[bucket];
    db.prepare('DELETE FROM metrics_agg WHERE bucket = ? AND ts < ?').run(bucket, cutoff);
  }
}

function cascadeAgg(
  db: Database.Database,
  from: BucketKey,
  to: BucketKey,
  now: number
): void {
  const cutoff = now - RETENTION_BY_BUCKET[from];
  const rows = db
    .prepare(
      'SELECT ts, metric, min, max, avg, samples FROM metrics_agg WHERE bucket = ? AND ts < ?'
    )
    .all(from, cutoff) as Array<{
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
    { bucket: number; metric: string; min: number; max: number; sum: number; samples: number }
  >();
  for (const r of rows) {
    const b = bucketStart(r.ts, to);
    const key = `${r.metric}|${b}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
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
    INSERT INTO metrics_agg (bucket, ts, metric, min, max, avg, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket, metric, ts) DO UPDATE SET
      min = MIN(min, excluded.min),
      max = MAX(max, excluded.max),
      avg = ((avg * samples) + (excluded.avg * excluded.samples)) / (samples + excluded.samples),
      samples = samples + excluded.samples
  `);
  const tx = db.transaction(() => {
    for (const entry of buckets.values()) {
      insert.run(
        to,
        entry.bucket,
        entry.metric,
        entry.min,
        entry.max,
        entry.sum / entry.samples,
        entry.samples
      );
    }
    db.prepare('DELETE FROM metrics_agg WHERE bucket = ? AND ts < ?').run(from, cutoff);
  });
  tx();
}

function upsertAgg(
  db: Database.Database,
  bucket: BucketKey,
  buckets: Array<{ bucket: number; metric: string; vals: number[] }>
): void {
  if (buckets.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO metrics_agg (bucket, ts, metric, min, max, avg, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket, metric, ts) DO UPDATE SET
      min = MIN(min, excluded.min),
      max = MAX(max, excluded.max),
      avg = ((avg * samples) + (excluded.avg * excluded.samples)) / (samples + excluded.samples),
      samples = samples + excluded.samples
  `);
  const tx = db.transaction(() => {
    for (const entry of buckets) {
      const min = Math.min(...entry.vals);
      const max = Math.max(...entry.vals);
      const sum = entry.vals.reduce((a, b) => a + b, 0);
      const avg = sum / entry.vals.length;
      insert.run(bucket, entry.bucket, entry.metric, min, max, avg, entry.vals.length);
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
  metrics: Partial<Record<MetricKey, AggPoint[]>>;
}

export function querySeries(range: RangeKey, metrics: MetricKey[]): SeriesResponse {
  const db = getDb();
  const now = Date.now();
  const { bucket, sinceMs } = pickBucket(range);
  const from = now - sinceMs;
  const out: Partial<Record<MetricKey, AggPoint[]>> = {};

  for (const metric of metrics) {
    if (bucket === 'raw') {
      const rows = db
        .prepare(
          'SELECT ts, value FROM metrics_raw WHERE metric = ? AND ts >= ? ORDER BY ts ASC'
        )
        .all(metric, from) as Array<{ ts: number; value: number }>;
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
          'SELECT ts, min, max, avg, samples FROM metrics_agg WHERE metric = ? AND bucket = ? AND ts >= ? ORDER BY ts ASC'
        )
        .all(metric, bucket, from) as Array<{
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

export function getStats(): {
  rawCount: number;
  aggCount: Record<BucketKey, number>;
  dbBytes: number;
} {
  const db = getDb();
  const rawCount = (db.prepare('SELECT COUNT(*) AS n FROM metrics_raw').get() as { n: number }).n;
  const aggCount = {} as Record<BucketKey, number>;
  for (const bucket of Object.keys(RETENTION_BY_BUCKET) as BucketKey[]) {
    aggCount[bucket] = (
      db.prepare('SELECT COUNT(*) AS n FROM metrics_agg WHERE bucket = ?').get(bucket) as {
        n: number;
      }
    ).n;
  }
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(DB_PATH).size;
  } catch {}
  return { rawCount, aggCount, dbBytes };
}
