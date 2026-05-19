/**
 * SQLite-backed Cron Run History
 * Persiste execuções de cron jobs localmente para histórico real e métricas.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "cron-runs.db");

export interface CronRunRecord {
  id: string;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: "success" | "error" | "running";
  duration_ms: number | null;
  error: string | null;
  trigger_type: "scheduled" | "manual";
  created_at: string;
}

export interface JobRunStats {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  successRate: number; // 0-100
  avgDurationMs: number;
  lastRunAt: string | null;
  lastStatus: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      duration_ms INTEGER,
      error TEXT,
      trigger_type TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_trigger ON cron_runs(trigger_type);
  `);

  return _db;
}

export function insertCronRun(record: Omit<CronRunRecord, "id" | "created_at">): CronRunRecord {
  const db = getDb();
  const id = `${record.job_id}-${Date.now()}`;
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO cron_runs (id, job_id, started_at, completed_at, status, duration_ms, error, trigger_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    record.job_id,
    record.started_at,
    record.completed_at ?? null,
    record.status,
    record.duration_ms ?? null,
    record.error ?? null,
    record.trigger_type,
    createdAt
  );

  return { ...record, id, created_at: createdAt };
}

export function getRunsByJobId(
  jobId: string,
  limit: number = 50
): CronRunRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(jobId, limit) as CronRunRecord[];
}

export function getRecentRuns(limit: number = 100): CronRunRecord[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as CronRunRecord[];
}

export function getJobStats(jobId: string, sinceDays: number = 30): JobRunStats {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  const sinceIso = since.toISOString();

  const total = db
    .prepare(
      `SELECT COUNT(*) as count FROM cron_runs WHERE job_id = ? AND started_at > ?`
    )
    .get(jobId, sinceIso) as { count: number };

  const success = db
    .prepare(
      `SELECT COUNT(*) as count FROM cron_runs WHERE job_id = ? AND status = 'success' AND started_at > ?`
    )
    .get(jobId, sinceIso) as { count: number };

  const error = db
    .prepare(
      `SELECT COUNT(*) as count FROM cron_runs WHERE job_id = ? AND status = 'error' AND started_at > ?`
    )
    .get(jobId, sinceIso) as { count: number };

  const avg = db
    .prepare(
      `SELECT AVG(duration_ms) as avg FROM cron_runs WHERE job_id = ? AND duration_ms IS NOT NULL AND started_at > ?`
    )
    .get(jobId, sinceIso) as { avg: number | null };

  const last = db
    .prepare(
      `SELECT started_at, status FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(jobId) as { started_at: string; status: string } | undefined;

  const totalRuns = total.count;
  const successCount = success.count;
  const errorCount = error.count;

  return {
    totalRuns,
    successCount,
    errorCount,
    successRate: totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0,
    avgDurationMs: Math.round(avg.avg ?? 0),
    lastRunAt: last?.started_at ?? null,
    lastStatus: last?.status ?? null,
  };
}

export function getGlobalStats(sinceDays: number = 7): {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgDurationMs: number;
  jobsWithRuns: number;
} {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  const sinceIso = since.toISOString();

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM cron_runs WHERE started_at > ?`)
    .get(sinceIso) as { count: number };

  const success = db
    .prepare(
      `SELECT COUNT(*) as count FROM cron_runs WHERE status = 'success' AND started_at > ?`
    )
    .get(sinceIso) as { count: number };

  const error = db
    .prepare(
      `SELECT COUNT(*) as count FROM cron_runs WHERE status = 'error' AND started_at > ?`
    )
    .get(sinceIso) as { count: number };

  const avg = db
    .prepare(
      `SELECT AVG(duration_ms) as avg FROM cron_runs WHERE duration_ms IS NOT NULL AND started_at > ?`
    )
    .get(sinceIso) as { avg: number | null };

  const jobs = db
    .prepare(
      `SELECT COUNT(DISTINCT job_id) as count FROM cron_runs WHERE started_at > ?`
    )
    .get(sinceIso) as { count: number };

  const totalRuns = total.count;
  return {
    totalRuns,
    successCount: success.count,
    errorCount: error.count,
    successRate: totalRuns > 0 ? Math.round((success.count / totalRuns) * 100) : 0,
    avgDurationMs: Math.round(avg.avg ?? 0),
    jobsWithRuns: jobs.count,
  };
}

export function cleanupOldRuns(retentionDays: number = 90): number {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - retentionDays);
  const sinceIso = since.toISOString();

  const result = db
    .prepare(`DELETE FROM cron_runs WHERE started_at < ?`)
    .run(sinceIso);

  return result.changes;
}

export function deleteRunsByJobId(jobId: string): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM cron_runs WHERE job_id = ?`).run(jobId);
  return result.changes;
}
