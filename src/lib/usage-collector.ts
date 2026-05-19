/**
 * Usage Collector - reads OpenClaw session usage and stores billable deltas.
 *
 * OpenClaw reports cumulative token totals per session. The collector keeps the
 * last seen counter for every session and persists only the positive delta, so
 * hourly/minute polling does not charge the same tokens repeatedly.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { calculateCost, normalizeModelId } from "./pricing";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { readOpenClawConfig } from "./openclaw-config";

const execFileAsync = promisify(execFile);
const OPENCLAW_TIMEOUT_MS = 10_000;
const OPENCLAW_MAX_BUFFER = 10 * 1024 * 1024;

export interface SessionData {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  updatedAt: number;
  percentUsed: number;
}

export interface UsageSnapshot {
  timestamp: number;
  date: string; // YYYY-MM-DD
  hour: number; // 0-23 UTC
  agentId: string;
  sessionKey: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  source: "initial" | "delta" | "reset";
}

export interface CollectionResult {
  collectedAt: number;
  source: "sessions-list" | "status";
  sessionsSeen: number;
  snapshotsInserted: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

interface StoredSessionState {
  session_key: string;
  agent_id: string;
  session_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeTokenTotals(inputTokens: number, outputTokens: number, totalTokens: number) {
  if (totalTokens > 0 && inputTokens === 0 && outputTokens === 0) {
    return { inputTokens: totalTokens, outputTokens: 0, totalTokens };
  }

  const derivedTotal = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : derivedTotal,
  };
}

function parseAgentIdFromKey(key: string): string {
  const parts = key.split(":");
  if (parts[0] === "agent" && parts[1]) return parts[1];
  return "main";
}

function isRunDuplicate(key: string): boolean {
  return key.split(":").includes("run");
}

async function runOpenClaw(args: string[]): Promise<unknown> {
  const config = readOpenClawConfig();
  const { stdout } = await execFileAsync(config.openclawBin, args, {
    timeout: OPENCLAW_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: OPENCLAW_MAX_BUFFER,
    env: {
      ...process.env,
      OPENCLAW_DIR: config.openclawDir,
      OPENCLAW_WORKSPACE: config.openclawWorkspace,
    },
  });

  return JSON.parse(stdout);
}

/**
 * Get current OpenClaw status with session data.
 */
export async function getOpenClawStatus(): Promise<unknown> {
  return runOpenClaw(["status", "--json"]);
}

/**
 * Get current OpenClaw sessions list.
 */
export async function getOpenClawSessionsList(): Promise<unknown> {
  return runOpenClaw(["sessions", "list", "--json"]);
}

/**
 * Extract session data from `openclaw sessions list --json`.
 */
export function extractSessionsListData(data: unknown): SessionData[] {
  if (!isRecord(data) || !Array.isArray(data.sessions)) return [];

  return data.sessions.reduce<SessionData[]>((sessions, raw) => {
    if (!isRecord(raw)) return sessions;

    const sessionKey = asString(raw.key, asString(raw.sessionId, ""));
    if (!sessionKey || isRunDuplicate(sessionKey)) return sessions;

    const rawInputTokens = Math.max(0, Math.floor(asNumber(raw.inputTokens)));
    const rawOutputTokens = Math.max(0, Math.floor(asNumber(raw.outputTokens)));
    const rawTotalTokens = Math.max(0, Math.floor(asNumber(raw.totalTokens)));
    const tokens = normalizeTokenTotals(rawInputTokens, rawOutputTokens, rawTotalTokens);

    sessions.push({
      agentId: parseAgentIdFromKey(sessionKey),
      sessionKey,
      sessionId: asString(raw.sessionId, sessionKey),
      model: normalizeModelId(asString(raw.model, "unknown")),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: tokens.totalTokens,
      updatedAt: asNumber(raw.updatedAt),
      percentUsed: asNumber(raw.percentUsed),
    });

    return sessions;
  }, []);
}

/**
 * Extract session data from `openclaw status --json`.
 */
export function extractSessionData(status: unknown): SessionData[] {
  const sessions: SessionData[] = [];

  if (!isRecord(status) || !isRecord(status.sessions) || !Array.isArray(status.sessions.byAgent)) {
    return sessions;
  }

  for (const agentGroup of status.sessions.byAgent) {
    if (!isRecord(agentGroup)) continue;

    const agentId = asString(agentGroup.agentId, "main");
    const recent = Array.isArray(agentGroup.recent) ? agentGroup.recent : [];

    for (const session of recent) {
      if (!isRecord(session)) continue;

      const sessionKey = asString(session.key, asString(session.sessionId, `${agentId}:unknown`));
      if (isRunDuplicate(sessionKey)) continue;

      const rawInputTokens = Math.max(0, Math.floor(asNumber(session.inputTokens)));
      const rawOutputTokens = Math.max(0, Math.floor(asNumber(session.outputTokens)));
      const rawTotalTokens = Math.max(0, Math.floor(asNumber(session.totalTokens)));
      const tokens = normalizeTokenTotals(rawInputTokens, rawOutputTokens, rawTotalTokens);

      sessions.push({
        agentId,
        sessionKey,
        sessionId: asString(session.sessionId, sessionKey),
        model: normalizeModelId(asString(session.model, "unknown")),
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        totalTokens: tokens.totalTokens,
        updatedAt: asNumber(session.updatedAt),
        percentUsed: asNumber(session.percentUsed),
      });
    }
  }

  return sessions;
}

async function getOpenClawUsageSessions(): Promise<{
  sessions: SessionData[];
  source: CollectionResult["source"];
}> {
  try {
    const data = await getOpenClawSessionsList();
    const sessions = extractSessionsListData(data);
    if (sessions.length > 0) {
      return { sessions, source: "sessions-list" };
    }
    throw new Error("openclaw sessions list returned empty array");
  } catch (sessionsError) {
    try {
      const status = await getOpenClawStatus();
      const sessions = extractSessionData(status);
      return { sessions, source: "status" };
    } catch (statusError) {
      const message = [
        sessionsError instanceof Error ? sessionsError.message : String(sessionsError),
        statusError instanceof Error ? statusError.message : String(statusError),
      ].filter(Boolean).join(" | ");
      throw new Error(`OpenClaw usage unavailable: ${message}`);
    }
  }
}

function dateParts(timestamp: number): { date: string; hour: number } {
  const date = new Date(timestamp);
  return {
    date: date.toISOString().split("T")[0],
    hour: date.getUTCHours(),
  };
}

/**
 * Calculate full point-in-time snapshots grouped by agent/model.
 *
 * Kept for callers that need a raw current total; collectUsage uses
 * calculateDeltaSnapshots to avoid repeated billing.
 */
export function calculateSnapshot(
  sessions: SessionData[],
  timestamp: number
): UsageSnapshot[] {
  const snapshots: UsageSnapshot[] = [];
  const { date, hour } = dateParts(timestamp);
  const grouped = new Map<string, SessionData[]>();

  for (const session of sessions) {
    const key = `${session.agentId}:${session.model}`;
    grouped.set(key, [...(grouped.get(key) ?? []), session]);
  }

  for (const [key, group] of grouped.entries()) {
    const [agentId, model] = key.split(":");
    const inputTokens = group.reduce((sum, s) => sum + s.inputTokens, 0);
    const outputTokens = group.reduce((sum, s) => sum + s.outputTokens, 0);
    const totalTokens = group.reduce((sum, s) => sum + s.totalTokens, 0);

    snapshots.push({
      timestamp,
      date,
      hour,
      agentId,
      sessionKey: key,
      sessionId: key,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      cost: calculateCost(model, inputTokens, outputTokens),
      source: "initial",
    });
  }

  return snapshots;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Initialize SQLite database for usage tracking.
 */
export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      session_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'delta',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS usage_session_state (
      session_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS usage_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  ensureColumn(db, "usage_snapshots", "session_key", "TEXT");
  ensureColumn(db, "usage_snapshots", "session_id", "TEXT");
  ensureColumn(db, "usage_snapshots", "source", "TEXT NOT NULL DEFAULT 'delta'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_date ON usage_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_agent ON usage_snapshots(agent_id);
    CREATE INDEX IF NOT EXISTS idx_model ON usage_snapshots(model);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_key ON usage_snapshots(session_key);
  `);

  return db;
}

function upsertSetting(db: Database.Database, key: string, value: string, timestamp: number): void {
  db.prepare(`
    INSERT INTO usage_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, timestamp);
}

/**
 * Save snapshot to database.
 */
export function saveSnapshot(
  db: Database.Database,
  snapshot: UsageSnapshot
): void {
  const stmt = db.prepare(`
    INSERT INTO usage_snapshots
      (timestamp, date, hour, agent_id, session_key, session_id, model, input_tokens, output_tokens, total_tokens, cost, source)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    snapshot.timestamp,
    snapshot.date,
    snapshot.hour,
    snapshot.agentId,
    snapshot.sessionKey,
    snapshot.sessionId,
    snapshot.model,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.totalTokens,
    snapshot.cost,
    snapshot.source
  );
}

function buildDeltaSnapshots(
  db: Database.Database,
  sessions: SessionData[],
  timestamp: number,
  source: CollectionResult["source"]
): UsageSnapshot[] {
  const { date, hour } = dateParts(timestamp);
  const selectState = db.prepare(`
    SELECT session_key, agent_id, session_id, model, input_tokens, output_tokens, total_tokens
    FROM usage_session_state
    WHERE session_key = ?
  `);
  const upsertState = db.prepare(`
    INSERT INTO usage_session_state
      (session_key, agent_id, session_id, model, input_tokens, output_tokens, total_tokens, last_seen_at, source, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      agent_id = excluded.agent_id,
      session_id = excluded.session_id,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      last_seen_at = excluded.last_seen_at,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  const snapshots: UsageSnapshot[] = [];

  for (const session of sessions) {
    const previous = selectState.get(session.sessionKey) as StoredSessionState | undefined;
    const counterReset = previous
      ? session.inputTokens < previous.input_tokens ||
        session.outputTokens < previous.output_tokens ||
        session.totalTokens < previous.total_tokens
      : false;

    const inputTokens = previous && !counterReset
      ? Math.max(0, session.inputTokens - previous.input_tokens)
      : session.inputTokens;
    const outputTokens = previous && !counterReset
      ? Math.max(0, session.outputTokens - previous.output_tokens)
      : session.outputTokens;
    const totalTokens = previous && !counterReset
      ? Math.max(0, session.totalTokens - previous.total_tokens)
      : session.totalTokens;

    const snapshotSource: UsageSnapshot["source"] = !previous
      ? "initial"
      : counterReset
        ? "reset"
        : "delta";

    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      snapshots.push({
        timestamp,
        date,
        hour,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        model: session.model,
        inputTokens,
        outputTokens,
        totalTokens,
        cost: calculateCost(session.model, inputTokens, outputTokens),
        source: snapshotSource,
      });
    }

    upsertState.run(
      session.sessionKey,
      session.agentId,
      session.sessionId,
      session.model,
      session.inputTokens,
      session.outputTokens,
      session.totalTokens,
      timestamp,
      source,
      Math.floor(timestamp / 1000)
    );
  }

  return snapshots;
}

/**
 * Collect and save current usage data.
 */
export async function collectUsage(dbPath: string): Promise<CollectionResult> {
  const db = initDatabase(dbPath);
  const timestamp = Date.now();

  try {
    const { sessions, source } = await getOpenClawUsageSessions();

    const snapshots = db.transaction(() => {
      const deltas = buildDeltaSnapshots(db, sessions, timestamp, source);
      for (const snapshot of deltas) {
        saveSnapshot(db, snapshot);
      }

      upsertSetting(db, "last_collected_at", String(timestamp), timestamp);
      upsertSetting(db, "last_collection_source", source, timestamp);
      upsertSetting(db, "last_sessions_seen", String(sessions.length), timestamp);
      upsertSetting(db, "last_snapshots_inserted", String(deltas.length), timestamp);
      upsertSetting(db, "last_collection_error", "", timestamp);

      return deltas;
    })();

    const result: CollectionResult = {
      collectedAt: timestamp,
      source,
      sessionsSeen: sessions.length,
      snapshotsInserted: snapshots.length,
      inputTokens: snapshots.reduce((sum, s) => sum + s.inputTokens, 0),
      outputTokens: snapshots.reduce((sum, s) => sum + s.outputTokens, 0),
      totalTokens: snapshots.reduce((sum, s) => sum + s.totalTokens, 0),
      cost: snapshots.reduce((sum, s) => sum + s.cost, 0),
    };

    return result;
  } catch (error) {
    upsertSetting(
      db,
      "last_collection_error",
      error instanceof Error ? error.message : String(error),
      timestamp
    );
    throw error;
  } finally {
    db.close();
  }
}
