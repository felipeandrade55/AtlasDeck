/**
 * Sessions API
 *
 * GET /api/sessions          -> live OpenClaw sessions with transcript metadata
 * GET /api/sessions?id=xxx   -> messages from a specific JSONL transcript
 */
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import path from "path";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const OPENCLAW_TIMEOUT_MS = 10_000;
const OPENCLAW_MAX_BUFFER = 10 * 1024 * 1024;

type SessionType = "main" | "cron" | "subagent" | "direct" | "unknown";
type SessionSource = "sessions-list" | "status" | "files";

interface RawSession extends Record<string, unknown> {
  key?: string;
  kind?: string;
  agentId?: string;
  updatedAt?: number | string;
  ageMs?: number | string;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  aborted?: boolean;
  inputTokens?: number | string;
  outputTokens?: number | string;
  totalTokens?: number | string;
  totalTokensFresh?: boolean;
  model?: string;
  modelProvider?: string;
  contextTokens?: number | string;
  contextWindow?: number | string;
  percentUsed?: number | string;
}

interface ParsedKey {
  type: SessionType;
  typeLabel: string;
  typeIcon: string;
  agentId: string;
  cronJobId?: string;
  subagentId?: string;
  channel?: string;
  runSessionId?: string;
  isRunEntry: boolean;
}

interface ParsedSession {
  id: string;
  key: string;
  type: SessionType;
  typeLabel: string;
  typeIcon: string;
  agentId: string;
  sessionId: string | null;
  cronJobId?: string;
  subagentId?: string;
  channel?: string;
  updatedAt: number;
  ageMs: number;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextUsedPercent: number | null;
  aborted: boolean;
  source: SessionSource;
  hasTranscript: boolean;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  title: string;
  transcriptUpdatedAt: number | null;
}

interface ParsedMessage {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "model_change" | "system";
  role?: string;
  content: string;
  timestamp: string;
  model?: string;
  toolName?: string;
}

interface TranscriptParseResult {
  messages: ParsedMessage[];
  stats: {
    messageCount: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    title: string;
    lastModel: string;
  };
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
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

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric, fallback);

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function toIsoTimestamp(value: unknown): string {
  return new Date(normalizeTimestamp(value)).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,160}$/.test(value) && !value.includes("..");
}

async function runOpenClaw(args: string[]): Promise<unknown> {
  const config = readOpenClawConfig();
  const { stdout } = await execFileAsync(config.openclawBin, args, {
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
  } catch (err) {
    const raw = String(stdout).trim();
    throw new Error(`Invalid JSON output from OpenClaw (Length: ${raw.length}):\n${raw.slice(0, 500)}`);
  }
}

function extractSessionsList(data: unknown): RawSession[] {
  if (Array.isArray(data)) return data.filter(isRecord) as RawSession[];
  if (isRecord(data) && Array.isArray(data.sessions)) {
    return data.sessions.filter(isRecord) as RawSession[];
  }
  return [];
}

function extractStatusSessions(data: unknown): RawSession[] {
  if (!isRecord(data) || !isRecord(data.sessions) || !Array.isArray(data.sessions.byAgent)) {
    return [];
  }

  const sessions: RawSession[] = [];
  for (const group of data.sessions.byAgent) {
    if (!isRecord(group)) continue;

    const agentId = asString(group.agentId, "main");
    const recent = Array.isArray(group.recent) ? group.recent : [];

    for (const raw of recent) {
      if (!isRecord(raw)) continue;
      sessions.push({ ...raw, agentId });
    }
  }

  return sessions;
}

function parseSessionKey(raw: RawSession): ParsedKey {
  const key = asString(raw.key, asString(raw.sessionKey, ""));
  const parts = key.split(":").filter(Boolean);
  const runIndex = parts.indexOf("run");
  const isRunEntry = runIndex >= 0;
  const agentId = parts[0] === "agent" && parts[1] ? parts[1] : asString(raw.agentId, "main");
  const scope = parts[2] || asString(raw.kind, "direct");
  const runSessionId = isRunEntry ? parts[runIndex + 1] : undefined;

  if (scope === "main") {
    return {
      type: "main",
      typeLabel: "Principal",
      typeIcon: "message-square",
      agentId,
      runSessionId,
      isRunEntry,
    };
  }

  if (scope === "cron") {
    return {
      type: "cron",
      typeLabel: isRunEntry ? "Execucao cron" : "Cron",
      typeIcon: "clock",
      agentId,
      cronJobId: parts[3],
      runSessionId,
      isRunEntry,
    };
  }

  if (scope === "subagent") {
    return {
      type: "subagent",
      typeLabel: "Sub-agente",
      typeIcon: "bot",
      agentId,
      subagentId: parts[3],
      runSessionId,
      isRunEntry,
    };
  }

  if (scope === "telegram" || scope === "direct" || scope === "chat" || scope === "slack") {
    return {
      type: "direct",
      typeLabel: scope === "telegram" ? "Telegram" : "Chat",
      typeIcon: "messages",
      agentId,
      channel: scope,
      runSessionId,
      isRunEntry,
    };
  }

  return {
    type: "unknown",
    typeLabel: scope ? scope : "Sessao",
    typeIcon: "circle-help",
    agentId,
    runSessionId,
    isRunEntry,
  };
}

function normalizeTokens(raw: RawSession) {
  const inputTokens = Math.max(0, Math.floor(asNumber(raw.inputTokens)));
  const outputTokens = Math.max(0, Math.floor(asNumber(raw.outputTokens)));
  const rawTotal = Math.max(0, Math.floor(asNumber(raw.totalTokens)));
  const derivedTotal = inputTokens + outputTokens;

  if (rawTotal > 0 && inputTokens === 0 && outputTokens === 0) {
    return { inputTokens: rawTotal, outputTokens: 0, totalTokens: rawTotal };
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: rawTotal > 0 ? rawTotal : derivedTotal,
  };
}

function findSessionFile(sessionId: string, agentId?: string): string | null {
  if (!safeSessionId(sessionId)) return null;

  const openclawDir = readOpenClawConfig().openclawDir;
  const candidates: string[] = [];
  const addCandidate = (id: string) => {
    candidates.push(path.join(openclawDir, "agents", id, "sessions", `${sessionId}.jsonl`));
  };

  if (agentId) addCandidate(agentId);
  if (agentId !== "main") addCandidate("main");

  for (const filePath of candidates) {
    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
    } catch {
      // Keep looking in other known locations.
    }
  }

  const agentsDir = path.join(openclawDir, "agents");
  try {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(agentsDir, entry.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
    }
  } catch {
    return null;
  }

  return null;
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) return valueToText(item.text ?? item.content ?? item.result ?? item);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}...` : value;
}

function parseTranscript(filePath: string, includeMessages: boolean): TranscriptParseResult {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: ParsedMessage[] = [];
  let lastModel = "";
  let title = "";
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;

  const pushMessage = (message: ParsedMessage) => {
    if (message.type === "user") {
      userMessages += 1;
      if (!title) title = truncate(message.content.replace(/\s+/g, " ").trim(), 88);
    } else if (message.type === "assistant") {
      assistantMessages += 1;
    } else if (message.type === "tool_use") {
      toolCalls += 1;
    }

    if (includeMessages) messages.push(message);
  };

  lines.forEach((line, lineIndex) => {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const type = asString(obj.type);
      const timestamp = toIsoTimestamp(obj.timestamp);

      if (type === "model_change") {
        lastModel = asString(obj.modelId, asString(obj.model, lastModel));
        pushMessage({
          id: asString(obj.id, `model-${lineIndex}`),
          type: "model_change",
          content: lastModel ? `Modelo alterado para ${lastModel}` : "Modelo alterado",
          timestamp,
          model: lastModel || undefined,
        });
        return;
      }

      if (type === "system") {
        const content = valueToText(obj.message ?? obj.content ?? obj.data);
        if (content) {
          pushMessage({
            id: asString(obj.id, `system-${lineIndex}`),
            type: "system",
            content: truncate(content, 800),
            timestamp,
            model: lastModel || undefined,
          });
        }
        return;
      }

      if (type !== "message" || !isRecord(obj.message)) return;

      const msg = obj.message;
      const role = asString(msg.role, "assistant");
      const messageTimestamp = obj.timestamp ?? msg.timestamp;
      const content = msg.content;
      const baseId = asString(obj.id, `line-${lineIndex}`);

      if (typeof content === "string") {
        pushMessage({
          id: baseId,
          type: role === "user" ? "user" : "assistant",
          role,
          content,
          timestamp: toIsoTimestamp(messageTimestamp),
          model: lastModel || undefined,
        });
        return;
      }

      if (!Array.isArray(content)) return;

      content.forEach((block, blockIndex) => {
        if (!isRecord(block)) return;

        const blockType = asString(block.type);
        if (blockType === "text") {
          const text = asString(block.text);
          if (!text) return;

          pushMessage({
            id: `${baseId}-text-${blockIndex}`,
            type: role === "user" ? "user" : "assistant",
            role,
            content: text,
            timestamp: toIsoTimestamp(messageTimestamp),
            model: lastModel || undefined,
          });
          return;
        }

        if (blockType === "tool_use") {
          const toolName = asString(block.name, "tool");
          const input = valueToText(block.input);
          pushMessage({
            id: asString(block.id, `${baseId}-tool-${blockIndex}`),
            type: "tool_use",
            role,
            content: input,
            timestamp: toIsoTimestamp(messageTimestamp),
            toolName,
            model: lastModel || undefined,
          });
          return;
        }

        if (blockType === "tool_result") {
          const result = valueToText(block.content ?? block.text ?? block.result);
          pushMessage({
            id: asString(block.id, `${baseId}-result-${blockIndex}`),
            type: "tool_result",
            role,
            content: truncate(result, 1000),
            timestamp: toIsoTimestamp(messageTimestamp),
            model: lastModel || undefined,
          });
        }
      });
    } catch {
      // Ignore malformed JSONL records; one bad line should not hide the session.
    }
  });

  return {
    messages,
    stats: {
      messageCount: userMessages + assistantMessages,
      userMessages,
      assistantMessages,
      toolCalls,
      title,
      lastModel,
    },
  };
}

function transcriptMetadata(sessionId: string | null, agentId: string) {
  if (!sessionId) return null;

  const filePath = findSessionFile(sessionId, agentId);
  if (!filePath) return null;

  try {
    const stat = statSync(filePath);
    const transcript = parseTranscript(filePath, false);
    return {
      filePath,
      updatedAt: stat.mtimeMs,
      ...transcript.stats,
    };
  } catch {
    return null;
  }
}

function buildSession(raw: RawSession, source: SessionSource): ParsedSession | null {
  const parsed = parseSessionKey(raw);
  const sessionId = asString(raw.sessionId, parsed.runSessionId || "");
  const key = asString(raw.key, sessionId ? `agent:${parsed.agentId}:session:${sessionId}` : "");
  if (!key && !sessionId) return null;

  const updatedAt = normalizeTimestamp(raw.updatedAt);
  const ageMs = Math.max(0, asNumber(raw.ageMs, Date.now() - updatedAt));
  const tokens = normalizeTokens(raw);
  const contextTokens = Math.max(
    0,
    Math.floor(asNumber(raw.contextTokens, asNumber(raw.contextWindow)))
  );
  const rawPercent = asNumber(raw.percentUsed, Number.NaN);
  const contextUsedPercent = Number.isFinite(rawPercent)
    ? Math.round(rawPercent)
    : contextTokens > 0
      ? Math.round((tokens.totalTokens / contextTokens) * 100)
      : null;
  const transcript = transcriptMetadata(sessionId || null, parsed.agentId);

  return {
    id: sessionId ? `${parsed.agentId}:${sessionId}` : key,
    key: key || sessionId,
    type: parsed.type,
    typeLabel: parsed.typeLabel,
    typeIcon: parsed.typeIcon,
    agentId: parsed.agentId,
    sessionId: sessionId || null,
    cronJobId: parsed.cronJobId,
    subagentId: parsed.subagentId,
    channel: parsed.channel,
    updatedAt: transcript?.updatedAt && transcript.updatedAt > updatedAt ? transcript.updatedAt : updatedAt,
    ageMs,
    model: asString(raw.model, transcript?.lastModel || "unknown"),
    modelProvider: asString(raw.modelProvider, "unknown"),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    contextTokens,
    contextUsedPercent,
    aborted: asBoolean(raw.abortedLastRun) || asBoolean(raw.aborted),
    source,
    hasTranscript: !!transcript,
    messageCount: transcript?.messageCount ?? 0,
    userMessages: transcript?.userMessages ?? 0,
    assistantMessages: transcript?.assistantMessages ?? 0,
    toolCalls: transcript?.toolCalls ?? 0,
    title: transcript?.title || parsed.typeLabel,
    transcriptUpdatedAt: transcript?.updatedAt ?? null,
  };
}

function sessionFromFile(agentId: string, filePath: string): ParsedSession | null {
  const sessionId = path.basename(filePath, ".jsonl");
  if (!safeSessionId(sessionId)) return null;

  try {
    const stat = statSync(filePath);
    const transcript = parseTranscript(filePath, false);
    const type: SessionType = agentId === "main" ? "main" : "subagent";

    return {
      id: `${agentId}:${sessionId}`,
      key: `agent:${agentId}:${type}:${sessionId}`,
      type,
      typeLabel: type === "main" ? "Principal" : "Sub-agente",
      typeIcon: type === "main" ? "message-square" : "bot",
      agentId,
      sessionId,
      updatedAt: stat.mtimeMs,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
      model: transcript.stats.lastModel || "unknown",
      modelProvider: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      contextUsedPercent: null,
      aborted: false,
      source: "files",
      hasTranscript: true,
      messageCount: transcript.stats.messageCount,
      userMessages: transcript.stats.userMessages,
      assistantMessages: transcript.stats.assistantMessages,
      toolCalls: transcript.stats.toolCalls,
      title: transcript.stats.title || "Transcricao JSONL",
      transcriptUpdatedAt: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function scanSessionsFromFiles(diagnostics: string[]): ParsedSession[] {
  const openclawDir = readOpenClawConfig().openclawDir;
  const agentsDir = path.join(openclawDir, "agents");
  if (!existsSync(agentsDir)) {
    diagnostics.push(`Diretorio de agentes nao encontrado: ${agentsDir}`);
    return [];
  }

  const sessions: ParsedSession[] = [];

  try {
    for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;

      const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
      if (!existsSync(sessionsDir)) continue;

      for (const sessionEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) continue;

        const session = sessionFromFile(agentEntry.name, path.join(sessionsDir, sessionEntry.name));
        if (session) sessions.push(session);
      }
    }
  } catch (error) {
    diagnostics.push(`Falha ao ler transcricoes: ${errorMessage(error)}`);
  }

  return sessions;
}

function mergeSessions(sessions: ParsedSession[]): ParsedSession[] {
  const byId = new Map<string, ParsedSession>();

  for (const session of sessions) {
    const key = session.sessionId ? `${session.agentId}:${session.sessionId}` : session.key;
    const current = byId.get(key);

    if (!current) {
      byId.set(key, session);
      continue;
    }

    const currentScore =
      (current.source === "sessions-list" ? 4 : current.source === "status" ? 3 : 1) +
      (current.totalTokens > 0 ? 2 : 0) +
      (current.hasTranscript ? 1 : 0);
    const nextScore =
      (session.source === "sessions-list" ? 4 : session.source === "status" ? 3 : 1) +
      (session.totalTokens > 0 ? 2 : 0) +
      (session.hasTranscript ? 1 : 0);

    const winner = nextScore > currentScore ? session : current;
    const transcript = session.hasTranscript ? session : current.hasTranscript ? current : null;

    byId.set(key, {
      ...winner,
      hasTranscript: !!transcript,
      messageCount: transcript?.messageCount ?? winner.messageCount,
      userMessages: transcript?.userMessages ?? winner.userMessages,
      assistantMessages: transcript?.assistantMessages ?? winner.assistantMessages,
      toolCalls: transcript?.toolCalls ?? winner.toolCalls,
      title: transcript?.title || winner.title,
      transcriptUpdatedAt: transcript?.transcriptUpdatedAt ?? winner.transcriptUpdatedAt,
      updatedAt: Math.max(winner.updatedAt, transcript?.updatedAt ?? 0),
    });
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readOpenClawSessions(diagnostics: string[]) {
  try {
    const data = await runOpenClaw(["sessions", "list"]);
    const sessions = extractSessionsList(data)
      .map((raw) => buildSession(raw, "sessions-list"))
      .filter((session): session is ParsedSession => !!session);

    if (sessions.length > 0) return { source: "sessions-list" as const, sessions };
    diagnostics.push("openclaw sessions list nao retornou sessoes.");
  } catch (error) {
    diagnostics.push(`openclaw sessions list falhou: ${errorMessage(error)}`);
  }

  try {
    const data = await runOpenClaw(["status"]);
    const sessions = extractStatusSessions(data)
      .map((raw) => buildSession(raw, "status"))
      .filter((session): session is ParsedSession => !!session);

    if (sessions.length > 0) return { source: "status" as const, sessions };
    diagnostics.push("openclaw status nao retornou sessoes recentes.");
  } catch (error) {
    diagnostics.push(`openclaw status falhou: ${errorMessage(error)}`);
  }

  return { source: null, sessions: [] };
}

async function listSessions(): Promise<NextResponse> {
  const config = readOpenClawConfig();
  const diagnostics: string[] = [];
  const openclaw = await readOpenClawSessions(diagnostics);
  const fileSessions = scanSessionsFromFiles(diagnostics);
  const sessions = mergeSessions([...openclaw.sessions, ...fileSessions]);
  const sources = [...new Set(sessions.map((session) => session.source))];
  const source = openclaw.source || (fileSessions.length > 0 ? "files" : "unavailable");
  const unavailable = sessions.length === 0 && source === "unavailable";

  return jsonNoStore({
    sessions,
    total: sessions.length,
    source,
    sources,
    generatedAt: Date.now(),
    openclawDir: config.openclawDir,
    openclawBin: config.openclawBin,
    diagnostics,
    error: unavailable
      ? "Nenhuma fonte real de sessoes esta disponivel. Configure OPENCLAW_DIR/OPENCLAW_BIN ou instale o CLI OpenClaw neste host."
      : null,
  });
}

async function getSessionMessages(request: NextRequest, sessionId: string): Promise<NextResponse> {
  if (!safeSessionId(sessionId)) {
    return jsonNoStore({ error: "Invalid session ID", messages: [] }, { status: 400 });
  }

  const agentId = request.nextUrl.searchParams.get("agentId") || undefined;
  const filePath = findSessionFile(sessionId, agentId);

  if (!filePath) {
    return jsonNoStore(
      { error: "Transcricao da sessao nao encontrada", messages: [] },
      { status: 404 }
    );
  }

  try {
    const transcript = parseTranscript(filePath, true);
    return jsonNoStore({
      sessionId,
      messages: transcript.messages,
      total: transcript.messages.length,
      stats: transcript.stats,
      transcriptUpdatedAt: statSync(filePath).mtimeMs,
    });
  } catch (error) {
    console.error("[sessions] Error reading session file:", error);
    return jsonNoStore(
      { error: "Failed to read session", detail: errorMessage(error), messages: [] },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("id");
  if (sessionId) return getSessionMessages(request, sessionId);
  return listSessions();
}
