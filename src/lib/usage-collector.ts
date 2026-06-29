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
import { collectFromJsonl, type JsonlCollectionResult } from "./usage-collector-jsonl";

const execFileAsync = promisify(execFile);
const OPENCLAW_TIMEOUT_MS = 15_000;
const OPENCLAW_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Try to resolve the full path to the openclaw binary using `which`.
 */
async function resolveOpenClawPath(binName: string): Promise<string | null> {
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, [binName], {
      timeout: 5_000,
      windowsHide: true,
    });
    const resolved = String(stdout).trim().split("\n")[0];
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic info about the OpenClaw environment.
 */
export async function getOpenClawDiagnostics(): Promise<{
  bin: string;
  resolvedPath: string | null;
  binExists: boolean;
  openclawDir: string;
  openclawWorkspace: string;
  pathEnv: string;
  platform: string;
}> {
  const config = readOpenClawConfig();
  const resolvedPath = await resolveOpenClawPath(config.openclawBin);
  const binExists = resolvedPath
    ? fs.existsSync(resolvedPath)
    : fs.existsSync(config.openclawBin);

  return {
    bin: config.openclawBin,
    resolvedPath,
    binExists,
    openclawDir: config.openclawDir,
    openclawWorkspace: config.openclawWorkspace,
    pathEnv: process.env.PATH || "",
    platform: process.platform,
  };
}

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
  source: "sessions-list" | "status" | "jsonl-only";
  sessionsSeen: number;
  snapshotsInserted: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  jsonl?: JsonlCollectionResult | null;
  cliError?: string | null;
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
  const resolved = await resolveOpenClawPath(config.openclawBin);
  const binToRun = resolved || config.openclawBin;

  try {
    const { stdout } = await execFileAsync(binToRun, args, {
      timeout: OPENCLAW_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: OPENCLAW_MAX_BUFFER,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DIR: config.openclawDir,
        OPENCLAW_WORKSPACE: config.openclawWorkspace,
      },
    });

    try {
      return JSON.parse(String(stdout));
    } catch {
      const raw = String(stdout).trim();
      throw new Error(`Invalid JSON from openclaw ${args.join(" ")} (len=${raw.length}): ${raw.slice(0, 300)}`);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; code?: string };
    const detail = err.stderr ? String(err.stderr).trim() : "";

    // Build a rich diagnostic message
    let diagnostic = "";
    if (err.code === "ENOENT") {
      diagnostic = `Binário '${config.openclawBin}' não encontrado no PATH. `;
      diagnostic += `Tentado: ${binToRun}. `;
      diagnostic += `Configure OPENCLAW_BIN no .env ou instale o OpenClaw no PATH do servidor. `;
    } else {
      diagnostic = `Falha ao executar '${config.openclawBin} ${args.join(" ")}'. `;
    }
    diagnostic += `Plataforma: ${process.platform}. `;
    diagnostic += `Diretório configurado: ${config.openclawDir}. `;

    const fullMessage = `${diagnostic}${err.message}${detail ? ` — ${detail}` : ""}`;
    throw new Error(fullMessage);
  }
}

/**
 * Try multiple argument formats for an OpenClaw command, returning the first
 * one that succeeds with valid JSON. This handles CLI version differences
 * (e.g. `sessions list --json` vs `sessions --json` vs `sessions-list --json`).
 */
async function tryOpenClawFormats(
  argSets: string[][],
  label: string
): Promise<{ data: unknown; format: string }> {
  const errors: string[] = [];

  for (const args of argSets) {
    try {
      const data = await runOpenClaw(args);
      return { data, format: args.join(" ") };
    } catch (error) {
      errors.push(`[${args.join(" ")}] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`${label}: all formats failed:\n${errors.join("\n")}`);
}

/**
 * Get current OpenClaw status with session data (JSON).
 */
export async function getOpenClawStatus(): Promise<unknown> {
  const { data } = await tryOpenClawFormats(
    [
      ["status", "--json"],
      ["status"],
    ],
    "openclaw status"
  );
  return data;
}

/**
 * Get current OpenClaw sessions list (JSON).
 */
export async function getOpenClawSessionsList(): Promise<unknown> {
  const { data } = await tryOpenClawFormats(
    [
      // Base command first — `sessions list` errors with "Too many
      // arguments" on OpenClaw 2026.5.12 (no `list` subcommand). The
      // `list` variants stay as fallbacks for builds that require them.
      ["sessions", "--json"],
      ["sessions"],
      ["sessions", "list", "--json"],
      ["sessions", "list"],
    ],
    "openclaw sessions"
  );
  return data;
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
  // Try sessions list first (most accurate)
  try {
    const data = await getOpenClawSessionsList();
    const sessions = extractSessionsListData(data);
    if (sessions.length > 0) {
      return { sessions, source: "sessions-list" };
    }
    // Empty sessions from a valid response is fine — fall through to status
  } catch {
    // sessions list failed — fall through to status
  }

  // Fallback: try status endpoint
  try {
    const status = await getOpenClawStatus();
    const sessions = extractSessionData(status);
    // Even empty sessions from a successful status call is valid
    return { sessions, source: "status" };
  } catch (statusError) {
    throw new Error(
      `OpenClaw indisponível: não foi possível obter sessões. Verifique se o OpenClaw está instalado e acessível. Detalhe: ${statusError instanceof Error ? statusError.message : String(statusError)}`
    );
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
      message_id TEXT,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS jsonl_cursors (
      file_path TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_size INTEGER NOT NULL DEFAULT 0,
      last_mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  ensureColumn(db, "usage_snapshots", "session_key", "TEXT");
  ensureColumn(db, "usage_snapshots", "session_id", "TEXT");
  ensureColumn(db, "usage_snapshots", "source", "TEXT NOT NULL DEFAULT 'delta'");
  ensureColumn(db, "usage_snapshots", "message_id", "TEXT");
  ensureColumn(db, "usage_snapshots", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "usage_snapshots", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_date ON usage_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_agent ON usage_snapshots(agent_id);
    CREATE INDEX IF NOT EXISTS idx_model ON usage_snapshots(model);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_key ON usage_snapshots(session_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_id
      ON usage_snapshots(session_key, message_id)
      WHERE message_id IS NOT NULL;
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

function hasJsonlTranscript(openclawDir: string, agentId: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const filePath = path.join(openclawDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function buildDeltaSnapshots(
  db: Database.Database,
  sessions: SessionData[],
  timestamp: number,
  source: CollectionResult["source"]
): UsageSnapshot[] {
  const { date, hour } = dateParts(timestamp);
  const openclawDir = readOpenClawConfig().openclawDir;
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
    // If the session has a JSONL transcript, the JSONL collector is the source
    // of truth — skip CLI delta tracking entirely to avoid double-counting.
    if (hasJsonlTranscript(openclawDir, session.agentId, session.sessionId)) {
      continue;
    }

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
 *
 * Two collectors run in parallel:
 *
 *  1. JSONL collector (primary, accurate) — reads `usage` blocks from each
 *     assistant message in `~/.openclaw/agents/<agent>/sessions/<id>.jsonl`.
 *     Idempotent via (session_key, message_id) unique index.
 *
 *  2. CLI collector (fallback) — runs `openclaw sessions list --json` and
 *     records deltas. Skips any session that has a JSONL transcript on
 *     disk to avoid double-counting (see `buildDeltaSnapshots`).
 *
 * A failure in the CLI collector does NOT fail the whole call — its error
 * is recorded and returned alongside whatever JSONL managed to ingest.
 */
export async function collectUsage(dbPath: string): Promise<CollectionResult> {
  const db = initDatabase(dbPath);
  const timestamp = Date.now();

  try {
    // 1. JSONL — primary source of truth, runs even if OpenClaw CLI is down.
    let jsonlResult: JsonlCollectionResult | null = null;
    try {
      jsonlResult = collectFromJsonl(db);
    } catch (error) {
      jsonlResult = null;
      upsertSetting(
        db,
        "last_jsonl_error",
        error instanceof Error ? error.message : String(error),
        timestamp
      );
    }

    // 2. CLI — fallback for sessions without a JSONL transcript yet.
    let cliSnapshots: UsageSnapshot[] = [];
    let cliSessionsSeen = 0;
    let cliSource: CollectionResult["source"] = "jsonl-only";
    let cliError: string | null = null;

    try {
      const { sessions, source } = await getOpenClawUsageSessions();
      cliSessionsSeen = sessions.length;
      cliSource = source;

      cliSnapshots = db.transaction(() => {
        const deltas = buildDeltaSnapshots(db, sessions, timestamp, source);
        for (const snapshot of deltas) {
          saveSnapshot(db, snapshot);
        }
        return deltas;
      })();
    } catch (error) {
      cliError = error instanceof Error ? error.message : String(error);
    }

    const totalSnapshotsInserted =
      cliSnapshots.length + (jsonlResult?.entriesIngested ?? 0);
    const totalInputTokens =
      cliSnapshots.reduce((sum, s) => sum + s.inputTokens, 0) +
      (jsonlResult?.inputTokens ?? 0);
    const totalOutputTokens =
      cliSnapshots.reduce((sum, s) => sum + s.outputTokens, 0) +
      (jsonlResult?.outputTokens ?? 0);
    const totalCacheTokens =
      (jsonlResult?.cacheReadTokens ?? 0) +
      (jsonlResult?.cacheCreationTokens ?? 0);
    const totalTokens =
      cliSnapshots.reduce((sum, s) => sum + s.totalTokens, 0) +
      (jsonlResult?.inputTokens ?? 0) +
      (jsonlResult?.outputTokens ?? 0) +
      totalCacheTokens;
    const totalCost =
      cliSnapshots.reduce((sum, s) => sum + s.cost, 0) +
      (jsonlResult?.cost ?? 0);

    upsertSetting(db, "last_collected_at", String(timestamp), timestamp);
    upsertSetting(db, "last_collection_source", cliSource, timestamp);
    upsertSetting(db, "last_sessions_seen", String(cliSessionsSeen), timestamp);
    upsertSetting(
      db,
      "last_snapshots_inserted",
      String(totalSnapshotsInserted),
      timestamp
    );
    upsertSetting(db, "last_collection_error", cliError ?? "", timestamp);
    if (jsonlResult) {
      upsertSetting(
        db,
        "last_jsonl_entries",
        String(jsonlResult.entriesIngested),
        timestamp
      );
      upsertSetting(
        db,
        "last_jsonl_files_updated",
        String(jsonlResult.filesUpdated),
        timestamp
      );
      upsertSetting(db, "last_jsonl_error", "", timestamp);
    }

    // If both collectors failed, surface the CLI error to the caller so the
    // existing UI banners ("OpenClaw indisponível") still fire correctly.
    if (cliError && (!jsonlResult || jsonlResult.entriesIngested === 0)) {
      throw new Error(cliError);
    }

    return {
      collectedAt: timestamp,
      source: cliSource,
      sessionsSeen: cliSessionsSeen,
      snapshotsInserted: totalSnapshotsInserted,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
      cost: totalCost,
      jsonl: jsonlResult,
      cliError,
    };
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
