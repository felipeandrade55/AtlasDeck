/**
 * SQLite-backed Activity Logger
 * Stores all agent activities with 365-day retention
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

const DB_PATH = path.join(process.cwd(), 'data', 'activities.db');

export type ActivityType =
  | 'file'
  | 'search'
  | 'message'
  | 'command'
  | 'security'
  | 'build'
  | 'task'
  | 'cron'
  | 'memory'
  | 'calendar'
  | 'backup'
  | 'restore'
  | 'update'
  | 'agent'
  | 'config'
  | 'cron_run'
  | 'file_read'
  | 'file_write'
  | 'web_search'
  | 'message_sent'
  | 'tool_call'
  | 'agent_action';

export type ActivityStatus = 'success' | 'error' | 'pending' | 'running';

export interface Activity {
  id: string;
  timestamp: string;
  type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  tokens_used: number | null;
  agent: string | null;
  pinned: boolean;
  metadata: Record<string, unknown> | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Use local `db` — only assign to `_db` after ALL initialization succeeds.
  // If we assign early and a migration throws, _db stays set to a broken
  // instance and every subsequent getDb() call returns it without retrying.
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // NOTE: the `pinned` index is created AFTER the migration below, NOT here.
  // On a pre-existing DB the table already exists without `pinned`, so
  // CREATE TABLE IF NOT EXISTS no-ops and a `CREATE INDEX ... ON activities(pinned)`
  // in this same block would throw "no such column: pinned" — aborting the
  // whole exec() before the ALTER migration ever runs. That was the bug.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER,
      tokens_used INTEGER,
      agent TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
    CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);
    CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent);
  `);

  // Add pinned column if missing (migration for DBs created before this column).
  // Use exec() — more reliable than prepare().run() for DDL.
  // Drop NOT NULL from ALTER TABLE: older SQLite builds reject NOT NULL even
  // with a DEFAULT; nullable INTEGER DEFAULT 0 behaves identically here.
  const existingCols = db.prepare('PRAGMA table_info(activities)').all() as Array<{ name: string }>;
  if (!existingCols.some(c => c.name === 'pinned')) {
    try {
      db.exec('ALTER TABLE activities ADD COLUMN pinned INTEGER DEFAULT 0');
      console.log('[activities-db] migration: added pinned column');
    } catch (e) {
      console.error('[activities-db] migration failed (pinned):', e);
      // Continue — queries that don't touch pinned will still work
    }
  }

  // Create the pinned index only now that the column is guaranteed to exist.
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_activities_pinned ON activities(pinned)');
  } catch (e) {
    console.error('[activities-db] index creation failed (pinned):', e);
  }

  // Migrate from JSON
  const count = (db.prepare('SELECT COUNT(*) as n FROM activities').get() as { n: number }).n;
  if (count === 0) {
    const jsonPath = path.join(process.cwd(), 'data', 'activities.json');
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const insert = db.prepare(`
          INSERT OR IGNORE INTO activities (id, timestamp, type, description, status, duration_ms, tokens_used, agent, pinned, metadata)
          VALUES (@id, @timestamp, @type, @description, @status, @duration_ms, @tokens_used, @agent, @pinned, @metadata)
        `);
        const insertMany = db.transaction((activities: Activity[]) => {
          for (const a of activities) {
            insert.run({
              ...a,
              agent: (a as Activity & { agent?: string }).agent ?? null,
              pinned: 0,
              metadata: a.metadata ? JSON.stringify(a.metadata) : null,
            });
          }
        });
        insertMany(Array.isArray(data) ? data : []);
        console.log(`[activities-db] Migrated ${Array.isArray(data) ? data.length : 0} activities from JSON`);
      } catch (e) {
        console.warn('[activities-db] Migration from JSON failed:', e);
      }
    }
  }

  _db = db;
  return _db;
}

export function logActivity(
  type: string,
  description: string,
  status: string,
  opts?: {
    duration_ms?: number | null;
    tokens_used?: number | null;
    agent?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Activity {
  const db = getDb();
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO activities (id, timestamp, type, description, status, duration_ms, tokens_used, agent, pinned, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    id, timestamp, type, description, status,
    opts?.duration_ms ?? null,
    opts?.tokens_used ?? null,
    opts?.agent ?? null,
    opts?.metadata ? JSON.stringify(opts.metadata) : null,
  );

  // Prune activities older than 365 days
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM activities WHERE timestamp < ? AND pinned = 0').run(cutoff);

  return { id, timestamp, type, description, status, duration_ms: opts?.duration_ms ?? null, tokens_used: opts?.tokens_used ?? null, agent: opts?.agent ?? null, pinned: false, metadata: opts?.metadata ?? null };
}

export function updateActivity(
  id: string,
  status: string,
  opts?: { duration_ms?: number; tokens_used?: number }
): void {
  const db = getDb();
  db.prepare(`
    UPDATE activities SET status = ?, duration_ms = COALESCE(?, duration_ms), tokens_used = COALESCE(?, tokens_used)
    WHERE id = ?
  `).run(status, opts?.duration_ms ?? null, opts?.tokens_used ?? null, id);
}

export function togglePinActivity(id: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT pinned FROM activities WHERE id = ?').get(id) as { pinned: number } | undefined;
  if (!row) return false;
  const newPinned = row.pinned ? 0 : 1;
  db.prepare('UPDATE activities SET pinned = ? WHERE id = ?').run(newPinned, id);
  return newPinned === 1;
}

export function getAgents(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT agent FROM activities WHERE agent IS NOT NULL AND agent != '' ORDER BY agent").all() as Array<{ agent: string }>;
  return rows.map(r => r.agent);
}

export interface GetActivitiesOptions {
  type?: string;
  status?: string;
  agent?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  sort?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
  pinned?: boolean;
}

export interface ActivityStats {
  today: number;
  successRate: number;
  avgDuration: number | null;
  totalTokens: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface ActivitiesResult {
  activities: Activity[];
  total: number;
  stats?: ActivityStats;
}

export const TYPE_ALIASES: Record<string, string> = {
  cron_run: 'cron',
  file_read: 'file',
  file_write: 'file',
  web_search: 'search',
  message_sent: 'message',
  tool_call: 'task',
  agent_action: 'task',
};

function parseRow(row: Record<string, unknown>): Activity {
  const rawType = row.type as string;
  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    type: TYPE_ALIASES[rawType] || rawType,
    description: row.description as string,
    status: row.status as string,
    duration_ms: row.duration_ms as number | null,
    tokens_used: row.tokens_used as number | null,
    agent: row.agent as string | null,
    pinned: (row.pinned as number) === 1,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  };
}

export function getActivities(opts: GetActivitiesOptions = {}): ActivitiesResult {
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.pinned) {
    conditions.push('pinned = 1');
  }

  if (opts.type && opts.type !== 'all') {
    const types = opts.type.split(',').map((t) => t.trim()).filter(Boolean);
    const aliases: Record<string, string[]> = {
      cron: ['cron', 'cron_run'],
      file: ['file', 'file_read', 'file_write'],
      search: ['search', 'web_search'],
      message: ['message', 'message_sent'],
      task: ['task', 'tool_call', 'agent_action'],
    };
    const expandedTypes = new Set<string>();
    for (const t of types) {
      if (aliases[t]) aliases[t].forEach(a => expandedTypes.add(a));
      else expandedTypes.add(t);
    }
    const expanded = Array.from(expandedTypes);
    conditions.push(`type IN (${expanded.map(() => '?').join(',')})`);
    params.push(...expanded);
  }

  if (opts.status && opts.status !== 'all') {
    conditions.push('status = ?');
    params.push(opts.status);
  }

  if (opts.agent && opts.agent !== 'all') {
    conditions.push('agent = ?');
    params.push(opts.agent);
  }

  if (opts.search && opts.search.trim()) {
    conditions.push('description LIKE ?');
    params.push(`%${opts.search.trim()}%`);
  }

  if (opts.startDate) {
    conditions.push('timestamp >= ?');
    params.push(opts.startDate);
  }

  if (opts.endDate) {
    conditions.push("timestamp <= datetime(?, '+1 day')");
    params.push(opts.endDate);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = opts.sort === 'oldest' ? 'ASC' : 'DESC';
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as n FROM activities ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM activities ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];

  return {
    activities: rows.map(parseRow),
    total,
  };
}

export function getActivityStats(): {
  total: number;
  today: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  avgDuration: number | null;
  totalTokens: number;
} {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const total = (db.prepare('SELECT COUNT(*) as n FROM activities').get() as { n: number }).n;
  const today = (db.prepare("SELECT COUNT(*) as n FROM activities WHERE timestamp >= ?").get(todayStart.toISOString()) as { n: number }).n;

  const typeRows = db.prepare("SELECT type, COUNT(*) as n FROM activities GROUP BY type").all() as Array<{ type: string; n: number }>;
  const byType: Record<string, number> = {};
  for (const r of typeRows) {
    const t = TYPE_ALIASES[r.type] || r.type;
    byType[t] = (byType[t] || 0) + r.n;
  }

  const statusRows = db.prepare("SELECT status, COUNT(*) as n FROM activities GROUP BY status").all() as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;

  const durationRow = db.prepare("SELECT AVG(duration_ms) as avg FROM activities WHERE duration_ms IS NOT NULL").get() as { avg: number | null };
  const tokensRow = db.prepare("SELECT SUM(tokens_used) as total FROM activities WHERE tokens_used IS NOT NULL").get() as { total: number | null };

  return {
    total,
    today,
    byType,
    byStatus,
    avgDuration: durationRow.avg !== null ? Math.round(durationRow.avg) : null,
    totalTokens: tokensRow.total ?? 0,
  };
}
