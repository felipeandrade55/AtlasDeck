/**
 * Registry of monitored VPS hosts + their per-host ingest token.
 *
 * Security model (manual enrollment): the token is GENERATED on the VPS by
 * the installer; the user pastes it into AtlasDeck to authorize the host.
 * We store only sha256(token) — the raw token is never persisted. Ingestion
 * resolves the host by hashing the inbound header; an unknown token is
 * rejected and NO host is auto-created.
 *
 * One SQLite file (data/vps.db) holds the host registry, the latest snapshot
 * (top processes / services / docker containers / per-mount disk) and the
 * per-metric alert state used for dedup.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { deleteVpsMetrics } from '@/lib/vps-metrics-db';

const DB_PATH = path.join(process.cwd(), 'data', 'vps.db');

export type HostStatus = 'pending' | 'online' | 'offline';
export type AlertLevel = 'none' | 'warning' | 'critical';

export interface ThresholdPair {
  warning: number;
  critical: number;
}

export interface VpsThresholds {
  cpu: ThresholdPair;
  ram: ThresholdPair;
  swap: ThresholdPair;
  disk: ThresholdPair;
  load1PerCore: ThresholdPair;
  offlineSec: number;
}

export interface MonitoredService {
  type: 'systemd' | 'docker';
  name: string;
}

export interface ProcessSnap {
  pid: number;
  name: string;
  cpu: number;
  memPct: number;
  cmd?: string;
}

export interface ServiceSnap {
  type: 'systemd' | 'docker';
  name: string;
  active: boolean;
  detail?: string;
}

export interface DiskSnap {
  mount: string;
  totalGb: number;
  usedGb: number;
  pct: number;
}

export interface ContainerSnap {
  id?: string;
  name: string;
  image?: string;
  state: string; // running | exited | dead | restarting | ...
  status?: string;
  cpu?: number;
  memPct?: number;
  memMb?: number;
  restarts?: number;
}

export interface DockerSnap {
  installed: boolean;
  running?: boolean;
  containers?: ContainerSnap[];
}

export interface VpsSnapshot {
  reportedAtMs?: number;
  agentTs?: number;
  metrics?: Record<string, number>;
  processes?: ProcessSnap[];
  services?: ServiceSnap[];
  disks?: DiskSnap[];
  docker?: DockerSnap;
  loadAvg?: [number, number, number];
  uptimeSec?: number;
}

export interface AlertState {
  cpu: AlertLevel;
  ram: AlertLevel;
  swap: AlertLevel;
  disk: AlertLevel;
  load: AlertLevel;
  process: AlertLevel;
  service: Record<string, 'ok' | 'down'>;
  docker: 'ok' | 'down';
  container: Record<string, 'running' | 'down'>;
  heartbeat: 'online' | 'offline';
}

export interface VpsHost {
  vps_id: string;
  name: string;
  hostname: string | null;
  created_at: string;
  last_seen_ms: number | null;
  status: HostStatus;
  os: string | null;
  agent_version: string | null;
  thresholds: VpsThresholds;
  monitored_services: MonitoredService[];
  monitor_docker: boolean;
  last_snapshot: VpsSnapshot;
}

export const DEFAULT_THRESHOLDS: VpsThresholds = {
  cpu: { warning: 80, critical: 95 },
  ram: { warning: 85, critical: 95 },
  swap: { warning: 50, critical: 80 },
  disk: { warning: 80, critical: 90 },
  load1PerCore: { warning: 1.5, critical: 3.0 },
  offlineSec: 180,
};

export const DEFAULT_ALERT_STATE: AlertState = {
  cpu: 'none',
  ram: 'none',
  swap: 'none',
  disk: 'none',
  load: 'none',
  process: 'none',
  service: {},
  docker: 'ok',
  container: {},
  heartbeat: 'online',
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
    CREATE TABLE IF NOT EXISTS vps_hosts (
      vps_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      os TEXT,
      agent_version TEXT,
      thresholds TEXT NOT NULL DEFAULT '{}',
      monitored_services TEXT NOT NULL DEFAULT '[]',
      monitor_docker INTEGER NOT NULL DEFAULT 1,
      last_alert_state TEXT NOT NULL DEFAULT '{}',
      last_snapshot TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_vps_hosts_status ON vps_hosts(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_hosts_token ON vps_hosts(token_hash);
  `);

  return _db;
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken.trim()).digest('hex');
}

interface HostRow {
  vps_id: string;
  name: string;
  hostname: string | null;
  created_at: string;
  last_seen_ms: number | null;
  status: HostStatus;
  os: string | null;
  agent_version: string | null;
  thresholds: string;
  monitored_services: string;
  monitor_docker: number;
  last_alert_state: string;
  last_snapshot: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** Map a DB row to the public host shape (token_hash is intentionally dropped). */
function rowToHost(row: HostRow): VpsHost {
  return {
    vps_id: row.vps_id,
    name: row.name,
    hostname: row.hostname,
    created_at: row.created_at,
    last_seen_ms: row.last_seen_ms,
    status: row.status,
    os: row.os,
    agent_version: row.agent_version,
    thresholds: { ...DEFAULT_THRESHOLDS, ...parseJson(row.thresholds, {}) },
    monitored_services: parseJson<MonitoredService[]>(row.monitored_services, []),
    monitor_docker: row.monitor_docker !== 0,
    last_snapshot: parseJson<VpsSnapshot>(row.last_snapshot, {}),
  };
}

export function tokenExists(rawToken: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM vps_hosts WHERE token_hash = ?')
    .get(hashToken(rawToken));
  return !!row;
}

export function createHost(input: { name: string; rawToken: string }): VpsHost {
  const db = getDb();
  const vps_id = randomUUID();
  const token_hash = hashToken(input.rawToken);
  db.prepare(
    `INSERT INTO vps_hosts (vps_id, name, token_hash, status, thresholds, monitored_services, monitor_docker, last_alert_state, last_snapshot)
     VALUES (?, ?, ?, 'pending', ?, '[]', 1, ?, '{}')`
  ).run(
    vps_id,
    input.name.trim(),
    token_hash,
    JSON.stringify(DEFAULT_THRESHOLDS),
    JSON.stringify(DEFAULT_ALERT_STATE)
  );
  return getHost(vps_id)!;
}

export function getHost(vpsId: string): VpsHost | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM vps_hosts WHERE vps_id = ?').get(vpsId) as
    | HostRow
    | undefined;
  return row ? rowToHost(row) : null;
}

export function getHostByToken(rawToken: string): VpsHost | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM vps_hosts WHERE token_hash = ?')
    .get(hashToken(rawToken)) as HostRow | undefined;
  return row ? rowToHost(row) : null;
}

export function listHosts(): VpsHost[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM vps_hosts ORDER BY name COLLATE NOCASE ASC')
    .all() as HostRow[];
  return rows.map(rowToHost);
}

export function updateHost(
  vpsId: string,
  patch: {
    name?: string;
    thresholds?: VpsThresholds;
    monitored_services?: MonitoredService[];
    monitor_docker?: boolean;
  }
): VpsHost | null {
  const db = getDb();
  const host = getHost(vpsId);
  if (!host) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name.trim());
  }
  if (patch.thresholds !== undefined) {
    sets.push('thresholds = ?');
    vals.push(JSON.stringify(patch.thresholds));
  }
  if (patch.monitored_services !== undefined) {
    sets.push('monitored_services = ?');
    vals.push(JSON.stringify(patch.monitored_services));
  }
  if (patch.monitor_docker !== undefined) {
    sets.push('monitor_docker = ?');
    vals.push(patch.monitor_docker ? 1 : 0);
  }
  if (sets.length === 0) return host;
  vals.push(vpsId);
  db.prepare(`UPDATE vps_hosts SET ${sets.join(', ')} WHERE vps_id = ?`).run(...vals);
  return getHost(vpsId);
}

/** Re-enroll a new token (e.g. after a reinstall generated a fresh one). */
export function updateHostToken(vpsId: string, rawToken: string): VpsHost | null {
  const db = getDb();
  db.prepare('UPDATE vps_hosts SET token_hash = ? WHERE vps_id = ?').run(
    hashToken(rawToken),
    vpsId
  );
  return getHost(vpsId);
}

export function deleteHost(vpsId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM vps_hosts WHERE vps_id = ?').run(vpsId);
  try {
    deleteVpsMetrics(vpsId);
  } catch {
    // best-effort: registry delete already succeeded
  }
}

export function touchHost(
  vpsId: string,
  patch: {
    hostname?: string | null;
    os?: string | null;
    agent_version?: string | null;
    lastSeenMs: number;
    status: HostStatus;
  }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE vps_hosts
       SET hostname = COALESCE(?, hostname),
           os = COALESCE(?, os),
           agent_version = COALESCE(?, agent_version),
           last_seen_ms = ?,
           status = ?
     WHERE vps_id = ?`
  ).run(
    patch.hostname ?? null,
    patch.os ?? null,
    patch.agent_version ?? null,
    patch.lastSeenMs,
    patch.status,
    vpsId
  );
}

export function setHostStatus(vpsId: string, status: HostStatus): void {
  const db = getDb();
  db.prepare('UPDATE vps_hosts SET status = ? WHERE vps_id = ?').run(status, vpsId);
}

export function updateSnapshot(vpsId: string, snapshot: VpsSnapshot): void {
  const db = getDb();
  db.prepare('UPDATE vps_hosts SET last_snapshot = ? WHERE vps_id = ?').run(
    JSON.stringify(snapshot),
    vpsId
  );
}

export function getAlertState(vpsId: string): AlertState {
  const db = getDb();
  const row = db
    .prepare('SELECT last_alert_state FROM vps_hosts WHERE vps_id = ?')
    .get(vpsId) as { last_alert_state: string } | undefined;
  if (!row) return { ...DEFAULT_ALERT_STATE };
  return { ...DEFAULT_ALERT_STATE, ...parseJson<Partial<AlertState>>(row.last_alert_state, {}) };
}

export function setAlertState(vpsId: string, state: AlertState): void {
  const db = getDb();
  db.prepare('UPDATE vps_hosts SET last_alert_state = ? WHERE vps_id = ?').run(
    JSON.stringify(state),
    vpsId
  );
}
