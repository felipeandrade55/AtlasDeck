/**
 * Usage Queries - read usage and cost data from SQLite.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  "data",
  "usage-tracking.db"
);

const DEFAULT_BUDGET = 100;
const DEFAULT_ALERT_THRESHOLD = 80;

export interface CostSummary {
  today: number;
  yesterday: number;
  thisMonth: number;
  lastMonth: number;
  projected: number;
}

export interface AgentCost {
  agent: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  percentOfTotal: number;
}

export interface ModelCost {
  model: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  percentOfTotal: number;
}

export interface DailyCost {
  date: string; // MM-DD
  dateIso: string; // YYYY-MM-DD
  cost: number;
  input: number;
  output: number;
}

export interface HourlyCost {
  hour: string; // HH:00
  timestamp: number;
  cost: number;
}

export interface SessionCost {
  sessionKey: string;
  sessionId: string | null;
  agent: string;
  model: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  lastSeenAt: number;
}

export interface UsageTotals {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSettings {
  budget: number;
  alertThreshold: number;
  limitTimeframe: 'daily' | 'weekly' | 'monthly';
  limitUsd: number;
  behaviorMode: 'alert_only' | 'alert_and_lock';
  lastAlertState: 'none' | 'warning' | 'exceeded';
  telegramBotToken: string;
  telegramChatId: string;
}

export interface CollectionMetadata {
  lastCollectedAt: number | null;
  lastCollectionSource: string | null;
  lastCollectionError: string | null;
  lastSessionsSeen: number;
  lastSnapshotsInserted: number;
  lastSnapshotAt: number | null;
  storedSnapshots: number;
  trackedSessions: number;
  jsonlEntriesIngested: number;
  jsonlSnapshotsTotal: number;
  jsonlFilesTracked: number;
  jsonlFilesUpdatedLast: number;
  jsonlError: string | null;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function dateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

function cutoffDate(days: number): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(days - 1, 0));
  return dateString(cutoff);
}

function eachDay(days: number): string[] {
  const result: string[] = [];
  for (let i = Math.max(days - 1, 0); i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    result.push(dateString(date));
  }
  return result;
}

function getSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM usage_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO usage_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function getDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database | null {
  if (!fs.existsSync(dbPath)) {
    console.warn(`Database not found: ${dbPath}`);
    return null;
  }
  return new Database(dbPath, { readonly: true });
}

/**
 * Get cost summary (today, yesterday, this month, last month).
 */
export function getCostSummary(db: Database.Database): CostSummary {
  const now = new Date();
  const today = dateString(now);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateString(yesterday);

  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStartStr = dateString(lastMonthStart);
  const lastMonthEndStr = dateString(lastMonthEnd);

  const todayResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date = ?
  `).get(today) as { total: number };

  const yesterdayResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date = ?
  `).get(yesterdayStr) as { total: number };

  const thisMonthResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ?
  `).get(thisMonthStart) as { total: number };

  const lastMonthResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ? AND date <= ?
  `).get(lastMonthStartStr, lastMonthEndStr) as { total: number };

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = Math.max(now.getDate(), 1);
  const avgDailySpend = thisMonthResult.total / daysElapsed;

  return {
    today: roundMoney(todayResult.total),
    yesterday: roundMoney(yesterdayResult.total),
    thisMonth: roundMoney(thisMonthResult.total),
    lastMonth: roundMoney(lastMonthResult.total),
    projected: roundMoney(avgDailySpend * daysInMonth),
  };
}

/**
 * Get total cost/tokens for a date range.
 */
export function getUsageTotals(db: Database.Database, days: number = 30): UsageTotals {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens
    FROM usage_snapshots
    WHERE date >= ?
  `).get(cutoffDate(days)) as UsageTotals;

  return {
    cost: roundMoney(row.cost),
    tokens: row.tokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

/**
 * Get cost breakdown by agent.
 */
export function getCostByAgent(db: Database.Database, days: number = 30): AgentCost[] {
  const results = db.prepare(`
    SELECT
      agent_id as agent,
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY agent_id
    ORDER BY cost DESC
  `).all(cutoffDate(days)) as AgentCost[];

  const total = results.reduce((sum, r) => sum + r.cost, 0);

  return results.map((r) => ({
    ...r,
    cost: roundMoney(r.cost),
    percentOfTotal: total > 0 ? (r.cost / total) * 100 : 0,
  }));
}

/**
 * Get cost breakdown by model.
 */
export function getCostByModel(db: Database.Database, days: number = 30): ModelCost[] {
  const results = db.prepare(`
    SELECT
      model,
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY model
    ORDER BY cost DESC
  `).all(cutoffDate(days)) as ModelCost[];

  const total = results.reduce((sum, r) => sum + r.cost, 0);

  return results.map((r) => ({
    ...r,
    cost: roundMoney(r.cost),
    percentOfTotal: total > 0 ? (r.cost / total) * 100 : 0,
  }));
}

/**
 * Get daily cost trend.
 */
export function getDailyCost(db: Database.Database, days: number = 30): DailyCost[] {
  const results = db.prepare(`
    SELECT
      date,
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(input_tokens), 0) as input,
      COALESCE(SUM(output_tokens), 0) as output
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(cutoffDate(days)) as Array<{
    date: string;
    cost: number;
    input: number;
    output: number;
  }>;

  const byDate = new Map(results.map((r) => [r.date, r]));

  return eachDay(days).map((day) => {
    const row = byDate.get(day);
    return {
      date: day.slice(5),
      dateIso: day,
      cost: roundMoney(row?.cost ?? 0),
      input: row?.input ?? 0,
      output: row?.output ?? 0,
    };
  });
}

/**
 * Get hourly cost trend for the last 24h.
 */
export function getHourlyCost(db: Database.Database): HourlyCost[] {
  const cutoffTimestamp = Date.now() - 23 * 60 * 60 * 1000;

  const results = db.prepare(`
    SELECT
      date,
      hour,
      COALESCE(SUM(cost), 0) as cost
    FROM usage_snapshots
    WHERE timestamp >= ?
    GROUP BY date, hour
  `).all(cutoffTimestamp) as Array<{
    date: string;
    hour: number;
    cost: number;
  }>;

  const byHour = new Map(
    results.map((r) => [`${r.date}:${String(r.hour).padStart(2, "0")}`, r.cost])
  );

  const rows: HourlyCost[] = [];
  for (let i = 23; i >= 0; i--) {
    const timestamp = Date.now() - i * 60 * 60 * 1000;
    const date = new Date(timestamp);
    const dateIso = dateString(date);
    const hour = date.getUTCHours();
    const key = `${dateIso}:${String(hour).padStart(2, "0")}`;

    rows.push({
      hour: `${String(hour).padStart(2, "0")}:00`,
      timestamp,
      cost: roundMoney(byHour.get(key) ?? 0),
    });
  }

  return rows;
}

/**
 * Get most expensive sessions in the selected range.
 */
export function getCostBySession(
  db: Database.Database,
  days: number = 30,
  limit: number = 20
): SessionCost[] {
  return db.prepare(`
    SELECT
      COALESCE(session_key, agent_id || ':' || model) as sessionKey,
      MAX(session_id) as sessionId,
      agent_id as agent,
      model,
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      MAX(timestamp) as lastSeenAt
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY COALESCE(session_key, agent_id || ':' || model), agent_id, model
    ORDER BY cost DESC
    LIMIT ?
  `).all(cutoffDate(days), limit).map((row) => {
    const session = row as SessionCost;
    return { ...session, cost: roundMoney(session.cost) };
  });
}

export function getCostSettings(db: Database.Database): CostSettings {
  const budget = safeNumber(
    getSetting(db, "monthly_budget_usd"),
    safeNumber(process.env.COST_MONTHLY_BUDGET_USD, DEFAULT_BUDGET)
  );
  const alertThreshold = safeNumber(
    getSetting(db, "alert_threshold_percent"),
    safeNumber(process.env.COST_ALERT_THRESHOLD_PERCENT, DEFAULT_ALERT_THRESHOLD)
  );

  const limitTimeframeRaw = getSetting(db, "limit_timeframe") || "monthly";
  const limitTimeframe = (["daily", "weekly", "monthly"].includes(limitTimeframeRaw)
    ? limitTimeframeRaw
    : "monthly") as "daily" | "weekly" | "monthly";

  const limitUsd = safeNumber(
    getSetting(db, "limit_usd"),
    budget
  );

  const behaviorModeRaw = getSetting(db, "behavior_mode") || "alert_only";
  const behaviorMode = (["alert_only", "alert_and_lock"].includes(behaviorModeRaw)
    ? behaviorModeRaw
    : "alert_only") as "alert_only" | "alert_and_lock";

  const lastAlertStateRaw = getSetting(db, "last_alert_state") || "none";
  const lastAlertState = (["none", "warning", "exceeded"].includes(lastAlertStateRaw)
    ? lastAlertStateRaw
    : "none") as "none" | "warning" | "exceeded";

  const telegramBotToken = getSetting(db, "telegram_bot_token") || "";
  const telegramChatId = getSetting(db, "telegram_chat_id") || "";

  return {
    budget: budget > 0 ? budget : DEFAULT_BUDGET,
    alertThreshold: Math.min(Math.max(alertThreshold, 1), 100),
    limitTimeframe,
    limitUsd: limitUsd > 0 ? limitUsd : budget,
    behaviorMode,
    lastAlertState,
    telegramBotToken,
    telegramChatId,
  };
}

export function setCostSettings(
  db: Database.Database,
  settings: Partial<CostSettings>
): CostSettings {
  if (settings.budget !== undefined) {
    if (!Number.isFinite(settings.budget) || settings.budget <= 0) {
      throw new Error("Budget must be a positive number");
    }
    setSetting(db, "monthly_budget_usd", String(settings.budget));
  }

  if (settings.alertThreshold !== undefined) {
    if (!Number.isFinite(settings.alertThreshold) || settings.alertThreshold <= 0 || settings.alertThreshold > 100) {
      throw new Error("Alert threshold must be between 1 and 100");
    }
    setSetting(db, "alert_threshold_percent", String(settings.alertThreshold));
  }

  if (settings.limitTimeframe !== undefined) {
    if (!["daily", "weekly", "monthly"].includes(settings.limitTimeframe)) {
      throw new Error("Invalid limit timeframe");
    }
    setSetting(db, "limit_timeframe", settings.limitTimeframe);
  }

  if (settings.limitUsd !== undefined) {
    if (!Number.isFinite(settings.limitUsd) || settings.limitUsd <= 0) {
      throw new Error("Limit USD must be a positive number");
    }
    setSetting(db, "limit_usd", String(settings.limitUsd));
  }

  if (settings.behaviorMode !== undefined) {
    if (!["alert_only", "alert_and_lock"].includes(settings.behaviorMode)) {
      throw new Error("Invalid behavior mode");
    }
    setSetting(db, "behavior_mode", settings.behaviorMode);
  }

  if (settings.lastAlertState !== undefined) {
    if (!["none", "warning", "exceeded"].includes(settings.lastAlertState)) {
      throw new Error("Invalid last alert state");
    }
    setSetting(db, "last_alert_state", settings.lastAlertState);
  }

  if (settings.telegramBotToken !== undefined) {
    setSetting(db, "telegram_bot_token", settings.telegramBotToken);
  }

  if (settings.telegramChatId !== undefined) {
    setSetting(db, "telegram_chat_id", settings.telegramChatId);
  }

  return getCostSettings(db);
}

/**
 * Get cost for the last N days.
 */
export function getCostForLastNDays(db: Database.Database, days: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ?
  `).get(cutoffDate(days)) as { total: number };
  return roundMoney(row.total);
}

/**
 * Get current cost for a specific timeframe.
 */
export function getCurrentCostForTimeframe(
  db: Database.Database,
  timeframe: 'daily' | 'weekly' | 'monthly'
): number {
  const now = new Date();
  
  if (timeframe === 'daily') {
    const today = dateString(now);
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date = ?
    `).get(today) as { total: number };
    return roundMoney(row.total);
  }
  
  if (timeframe === 'weekly') {
    return getCostForLastNDays(db, 7);
  }
  
  // timeframe === 'monthly'
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ?
  `).get(thisMonthStart) as { total: number };
  return roundMoney(row.total);
}

/**
 * Check if the budget lock is currently active.
 */
export function checkIsCostLocked(db: Database.Database): boolean {
  try {
    const settings = getCostSettings(db);
    if (settings.behaviorMode !== 'alert_and_lock') return false;
    
    const timeframe = settings.limitTimeframe || 'monthly';
    const limit = settings.limitUsd || settings.budget;
    const current = getCurrentCostForTimeframe(db, timeframe);
    
    return current >= limit;
  } catch (error) {
    console.error("Error checking is cost locked:", error);
    return false;
  }
}

export function getCollectionMetadata(db: Database.Database): CollectionMetadata {
  const snapshotRow = db.prepare(`
    SELECT
      MAX(timestamp) as lastSnapshotAt,
      COUNT(*) as storedSnapshots,
      COUNT(DISTINCT COALESCE(session_key, agent_id || ':' || model)) as trackedSessions
    FROM usage_snapshots
  `).get() as {
    lastSnapshotAt: number | null;
    storedSnapshots: number;
    trackedSessions: number;
  };

  let jsonlSnapshotsTotal = 0;
  let jsonlFilesTracked = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM usage_snapshots WHERE source = 'jsonl'
    `).get() as { c: number };
    jsonlSnapshotsTotal = row.c;
  } catch {
    jsonlSnapshotsTotal = 0;
  }
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM jsonl_cursors`).get() as { c: number };
    jsonlFilesTracked = row.c;
  } catch {
    jsonlFilesTracked = 0;
  }

  return {
    lastCollectedAt: safeNumber(getSetting(db, "last_collected_at"), 0) || null,
    lastCollectionSource: getSetting(db, "last_collection_source"),
    lastCollectionError: getSetting(db, "last_collection_error") || null,
    lastSessionsSeen: safeNumber(getSetting(db, "last_sessions_seen"), 0),
    lastSnapshotsInserted: safeNumber(getSetting(db, "last_snapshots_inserted"), 0),
    lastSnapshotAt: snapshotRow.lastSnapshotAt,
    storedSnapshots: snapshotRow.storedSnapshots,
    trackedSessions: snapshotRow.trackedSessions,
    jsonlEntriesIngested: safeNumber(getSetting(db, "last_jsonl_entries"), 0),
    jsonlSnapshotsTotal,
    jsonlFilesTracked,
    jsonlFilesUpdatedLast: safeNumber(getSetting(db, "last_jsonl_files_updated"), 0),
    jsonlError: getSetting(db, "last_jsonl_error") || null,
  };
}
