/**
 * JSONL Usage Collector — reads token usage directly from OpenClaw transcripts.
 *
 * Each session in OpenClaw is persisted as an append-only JSONL file at
 *   ${OPENCLAW_DIR}/agents/<agentId>/sessions/<sessionId>.jsonl
 *
 * Format (per OpenClaw docs):
 *   - First line: { type: "session", id, timestamp, cwd, ... }
 *   - Subsequent lines: { type: "message", id, timestamp, parentId, message: {...} }
 *
 * Assistant messages include a `usage` block with normalized fields:
 *   { input, output, cacheRead, cacheWrite }
 *
 * Each ingestion is idempotent: we use (session_key, message_id) as a unique
 * key (see initDatabase) so reprocessing a file is a no-op. We track per-file
 * progress in `jsonl_cursors` (last byte offset + mtime) so polls only re-read
 * the new tail of each file.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { calculateCost, normalizeModelId } from "./pricing";
import { readOpenClawConfig } from "./openclaw-config";

export interface JsonlCollectionResult {
  scannedAt: number;
  filesScanned: number;
  filesUpdated: number;
  entriesIngested: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  openclawDir: string;
}

interface CursorRow {
  last_size: number;
  last_mtime_ms: number;
  last_message_id: string | null;
}

interface ParsedUsage {
  messageId: string;
  model: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeIntToken(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

function pickToken(usage: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (value !== undefined && value !== null) return safeIntToken(value);
  }
  return 0;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sessionKey(agentId: string, sessionId: string): string {
  return `agent:${agentId}:session:${sessionId}`;
}

function dateParts(timestampMs: number): { date: string; hour: number } {
  const d = new Date(timestampMs);
  return { date: d.toISOString().split("T")[0], hour: d.getUTCHours() };
}

/**
 * Parse one JSONL line. Returns the assistant message's token usage if the
 * line is a chargeable message, otherwise null.
 *
 * Accepts both OpenClaw's normalized field names (input/output/cacheRead/
 * cacheWrite) and the raw Anthropic field names (input_tokens/output_tokens/
 * cache_read_input_tokens/cache_creation_input_tokens) as a defensive
 * fallback — OpenClaw normalizes on read but providers/versions vary.
 */
export function extractUsageFromLine(line: string, fallbackTs: number): ParsedUsage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj.type !== "message") return null;

  const msg = obj.message;
  if (!isRecord(msg)) return null;
  if (msg.role !== "assistant") return null;

  const usage = msg.usage;
  if (!isRecord(usage)) return null;

  const inputTokens = pickToken(usage, "input", "inputTokens", "input_tokens");
  const outputTokens = pickToken(usage, "output", "outputTokens", "output_tokens");
  const cacheReadTokens = pickToken(usage, "cacheRead", "cache_read", "cache_read_input_tokens");
  const cacheCreationTokens = pickToken(usage, "cacheWrite", "cache_write", "cache_creation_input_tokens");

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreationTokens === 0
  ) {
    return null;
  }

  const messageId =
    (typeof obj.id === "string" && obj.id) ||
    (typeof msg.id === "string" && (msg.id as string)) ||
    "";
  if (!messageId) return null;

  const rawModel =
    (typeof msg.model === "string" && (msg.model as string)) ||
    (typeof obj.model === "string" && obj.model) ||
    "unknown";
  const model = normalizeModelId(rawModel);

  const timestamp = parseTimestamp(obj.timestamp ?? msg.timestamp, fallbackTs);

  return {
    messageId,
    model,
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

interface SessionFile {
  agentId: string;
  sessionId: string;
  filePath: string;
}

function listSessionFiles(openclawDir: string): SessionFile[] {
  const result: SessionFile[] = [];
  const agentsDir = path.join(openclawDir, "agents");
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agent.name, "sessions");
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of sessionEntries) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      result.push({
        agentId: agent.name,
        sessionId: file.name.slice(0, -".jsonl".length),
        filePath: path.join(sessionsDir, file.name),
      });
    }
  }

  return result;
}

function readFileTail(filePath: string, startOffset: number, endOffset: number): Buffer | null {
  if (endOffset <= startOffset) return Buffer.alloc(0);
  const length = endOffset - startOffset;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, startOffset);
    return buf;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Find the byte offset (exclusive) of the last complete line ending in LF.
 * Returns -1 if there is no complete line in the buffer.
 */
function lastCompleteLineEnd(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) return i + 1;
  }
  return -1;
}

/**
 * Scan all session transcripts and ingest any new assistant messages.
 *
 * Safe to call frequently — files that haven't changed since last poll are
 * skipped via mtime+size compare; files that have grown are read only from
 * the previous offset.
 */
export function collectFromJsonl(db: Database.Database): JsonlCollectionResult {
  const config = readOpenClawConfig();
  const openclawDir = config.openclawDir;
  const scannedAt = Date.now();

  const result: JsonlCollectionResult = {
    scannedAt,
    filesScanned: 0,
    filesUpdated: 0,
    entriesIngested: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
    openclawDir,
  };

  const files = listSessionFiles(openclawDir);

  const selectCursor = db.prepare(
    `SELECT last_size, last_mtime_ms, last_message_id FROM jsonl_cursors WHERE file_path = ?`
  );
  const upsertCursor = db.prepare(`
    INSERT INTO jsonl_cursors
      (file_path, agent_id, session_id, last_size, last_mtime_ms, last_message_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      last_size = excluded.last_size,
      last_mtime_ms = excluded.last_mtime_ms,
      last_message_id = excluded.last_message_id,
      updated_at = excluded.updated_at
  `);
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO usage_snapshots
      (timestamp, date, hour, agent_id, session_key, session_id, model,
       input_tokens, output_tokens, total_tokens,
       cache_read_tokens, cache_creation_tokens,
       cost, source, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jsonl', ?)
  `);

  for (const file of files) {
    result.filesScanned++;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.filePath);
    } catch {
      continue;
    }

    const cursor = selectCursor.get(file.filePath) as CursorRow | undefined;
    const lastSize = cursor?.last_size ?? 0;
    const lastMtime = cursor?.last_mtime_ms ?? 0;

    if (cursor && stat.size === lastSize && stat.mtimeMs <= lastMtime) {
      continue;
    }

    // If the file shrank we assume rotation / truncation and replay from 0;
    // INSERT OR IGNORE keeps it idempotent against already-stored message ids.
    const startOffset = stat.size < lastSize ? 0 : lastSize;

    const buf = readFileTail(file.filePath, startOffset, stat.size);
    if (!buf || buf.length === 0) {
      upsertCursor.run(
        file.filePath,
        file.agentId,
        file.sessionId,
        stat.size,
        stat.mtimeMs,
        cursor?.last_message_id ?? null,
        scannedAt
      );
      continue;
    }

    const completeEnd = lastCompleteLineEnd(buf);
    if (completeEnd < 0) {
      // No complete line in the new tail — wait for the next poll without
      // advancing the offset, so we re-read once the writer flushes a newline.
      continue;
    }

    const processable = buf.subarray(0, completeEnd).toString("utf8");
    const newOffset = startOffset + completeEnd;
    const lines = processable.split("\n");

    const sessKey = sessionKey(file.agentId, file.sessionId);
    let lastMessageId = cursor?.last_message_id ?? null;
    let inserted = 0;
    let fileInput = 0;
    let fileOutput = 0;
    let fileCacheRead = 0;
    let fileCacheCreation = 0;
    let fileCost = 0;

    const tx = db.transaction(() => {
      for (const line of lines) {
        if (!line) continue;
        const entry = extractUsageFromLine(line, stat.mtimeMs);
        if (!entry) continue;

        const { date, hour } = dateParts(entry.timestamp);
        const totalTokens =
          entry.inputTokens +
          entry.outputTokens +
          entry.cacheReadTokens +
          entry.cacheCreationTokens;
        const cost = calculateCost(
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheReadTokens,
          entry.cacheCreationTokens
        );

        const info = insertSnapshot.run(
          entry.timestamp,
          date,
          hour,
          file.agentId,
          sessKey,
          file.sessionId,
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          totalTokens,
          entry.cacheReadTokens,
          entry.cacheCreationTokens,
          cost,
          entry.messageId
        );

        if (info.changes > 0) {
          inserted++;
          lastMessageId = entry.messageId;
          fileInput += entry.inputTokens;
          fileOutput += entry.outputTokens;
          fileCacheRead += entry.cacheReadTokens;
          fileCacheCreation += entry.cacheCreationTokens;
          fileCost += cost;
        }
      }

      upsertCursor.run(
        file.filePath,
        file.agentId,
        file.sessionId,
        newOffset,
        stat.mtimeMs,
        lastMessageId,
        scannedAt
      );
    });

    tx();

    if (inserted > 0) {
      result.filesUpdated++;
      result.entriesIngested += inserted;
      result.inputTokens += fileInput;
      result.outputTokens += fileOutput;
      result.cacheReadTokens += fileCacheRead;
      result.cacheCreationTokens += fileCacheCreation;
      result.cost += fileCost;
    }
  }

  return result;
}
