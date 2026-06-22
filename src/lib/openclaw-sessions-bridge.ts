/**
 * Bridge that imports OpenClaw JSONL session transcripts into the
 * AtlasDeck chat database so the `/chat` UI can browse the same
 * conversations the agents have been having outside the web UI
 * (cron runs, Telegram-driven sessions, direct CLI usage, etc.).
 *
 * Idempotent: each thread tracks the file mtime and the last imported
 * line count in its metadata. A second run only ingests new lines.
 *
 * The OpenClaw JSONL format mixes `type: "message"` records (with
 * either a string content or an array of content blocks for text/
 * tool_use/tool_result) with sidecar records like `model_change`
 * and `system`. We translate them into our chat schema preserving:
 *   - user/assistant text → role messages
 *   - tool_use / tool_result blocks → typed tool messages
 *   - system messages → role: system
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import {
  appendMessage,
  createThread,
  deleteMessage,
  getThreadBySource,
  listMessages,
  updateThread,
  type ChatRole,
} from "@/lib/chat-db";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";
import { createTask, updateTask } from "@/lib/tasks-db";
import { publishEvent } from "@/lib/live-events";

// Only the orchestrator's own turns become Live Mission cards here. Specialist
// sub-agent runs already get their own cards from the task-worker, so we don't
// want the watcher to double-count them when it later imports their sessions.
const ORCHESTRATOR_IDS = new Set(["main", "jarvis"]);

// Heuristic: which Telegram/CLI turns are "real work" worth a kanban card.
// Mirrors the chat-stream gate so "bom dia" / quick Q&A don't flood the board.
const SUBSTANTIAL_TURN_RE =
  /\b(crie|criar|cria|faça|faca|fazer|implemente|implementar|corrija|corrigir|ajuste|ajustar|altere|alterar|edite|editar|rode|rodar|execute|executar|pesquise|pesquisar|analise|analisar|planeje|planejar|resolva|resolver|investigue|investigar|diagnostique|diagnosticar|instale|instalar|configure|configurar|publique|publicar|deploy|teste|testar|debug|debugar|refatore|refatorar|gere|gerar|importe|importar|sincronize|sincronizar|adicione|adicionar|monte|montar|escreva|escrever|atualize|atualizar|leia|ler)\b/i;

function isSubstantialTurn(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (normalized.length >= 120) return true;
  return SUBSTANTIAL_TURN_RE.test(normalized);
}

export interface AvailableSession {
  agentId: string;
  sessionId: string;
  filePath: string;
  sizeBytes: number;
  updatedAt: number;
  alreadyImported: boolean;
  threadId: string | null;
  messageCount: number;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  threads: Array<{
    agentId: string;
    sessionId: string;
    threadId: string;
    messagesAdded: number;
  }>;
  errors: Array<{ sessionId: string; error: string }>;
}

interface ParsedRecord {
  role: ChatRole;
  content: string;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: string | null;
  created_at: string;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item)
          ? valueToText(item.text ?? item.content ?? item.result ?? item)
          : typeof item === "string"
          ? item
          : "",
      )
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

function toIso(timestamp: unknown): string {
  if (typeof timestamp === "string") {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function parseLine(line: string): ParsedRecord[] {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return [];
    obj = parsed;
  } catch {
    return [];
  }

  const type = asString(obj.type);
  const timestamp = toIso(obj.timestamp);

  if (type === "system") {
    const content = valueToText(obj.message ?? obj.content ?? obj.data);
    if (!content) return [];
    return [{ role: "system", content, created_at: timestamp }];
  }

  if (type !== "message" || !isRecord(obj.message)) return [];

  const msg = obj.message;
  const role = asString(msg.role, "assistant");
  const content = msg.content;

  if (typeof content === "string") {
    return [
      {
        role: role === "user" ? "user" : "assistant",
        content,
        created_at: timestamp,
      },
    ];
  }

  if (!Array.isArray(content)) return [];

  const out: ParsedRecord[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = asString(block.type);

    if (blockType === "text") {
      const text = asString(block.text);
      if (text) {
        out.push({
          role: role === "user" ? "user" : "assistant",
          content: text,
          created_at: timestamp,
        });
      }
    } else if (blockType === "tool_use") {
      out.push({
        role: "tool_use",
        content: asString(block.name, "tool"),
        tool_name: asString(block.name, "tool"),
        tool_input: block.input ?? null,
        created_at: timestamp,
      });
    } else if (blockType === "tool_result") {
      const output = valueToText(block.content ?? block.text ?? block.result);
      out.push({
        role: "tool_result",
        content: output.slice(0, 4000),
        tool_output: output,
        created_at: timestamp,
      });
    }
  }
  return out;
}

function deriveTitle(records: ParsedRecord[], sessionId: string): string {
  const firstUser = records.find((r) => r.role === "user" && r.content.trim().length > 0);
  if (firstUser) {
    const collapsed = firstUser.content.replace(/\s+/g, " ").trim();
    return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
  }
  return `Sessão ${sessionId.slice(0, 12)}…`;
}

/**
 * Walks the OpenClaw `agents/<id>/sessions/*.jsonl` tree and returns a
 * status snapshot per session: whether AtlasDeck already imported it,
 * the size on disk, and the corresponding thread (if any).
 */
export function listAvailableSessions(): AvailableSession[] {
  const config = readOpenClawConfig();
  const agentsDir = path.join(config.openclawDir, "agents");
  if (!existsSync(agentsDir)) return [];

  const results: AvailableSession[] = [];
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.replace(/\.jsonl$/, "");
      const filePath = path.join(sessionsDir, entry);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        const existing = getThreadBySource("openclaw_import", sessionId);
        results.push({
          agentId,
          sessionId,
          filePath,
          sizeBytes: stat.size,
          updatedAt: stat.mtimeMs,
          alreadyImported: Boolean(existing),
          threadId: existing?.id ?? null,
          messageCount: existing?.message_count ?? 0,
        });
      } catch {
        // ignore unreadable files
      }
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

interface ImportOptions {
  sessionIds?: string[];
  force?: boolean;
  maxLines?: number;
}

/**
 * Imports OpenClaw sessions into the chat database. When `sessionIds`
 * is omitted, all sessions are processed. When `force` is true, the
 * thread is rebuilt from scratch (existing messages dropped); otherwise
 * the bridge skips files whose mtime + line count match the previous
 * import.
 */
export function importOpenClawSessions(opts: ImportOptions = {}): ImportSummary {
  const summary: ImportSummary = {
    imported: 0,
    skipped: 0,
    failed: 0,
    threads: [],
    errors: [],
  };

  const available = listAvailableSessions();
  const targets = opts.sessionIds
    ? available.filter((s) => opts.sessionIds!.includes(s.sessionId))
    : available;
  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;

  for (const session of targets) {
    try {
      const stat = statSync(session.filePath);
      const raw = readFileSync(session.filePath, "utf8");
      const lines = raw.split(/\r?\n/);

      // Skip sessions that are already being tracked by a live web thread
      // (user sent the message via the web UI → OpenClaw gateway wrote a JSONL
      // file → watcher would create a ghost duplicate here).
      if (getThreadBySource("web", session.sessionId)) {
        summary.skipped += 1;
        continue;
      }

      let thread = getThreadBySource("openclaw_import", session.sessionId);
      const existingMetaImport = thread?.metadata?.openclawImport as
        | { mtimeMs?: number; lineCount?: number }
        | undefined;

      const unchanged =
        !opts.force &&
        thread &&
        existingMetaImport &&
        existingMetaImport.mtimeMs === stat.mtimeMs &&
        existingMetaImport.lineCount === lines.length;
      if (unchanged) {
        summary.skipped += 1;
        continue;
      }

      const records: ParsedRecord[] = [];
      let consumed = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        consumed += 1;
        if (consumed > maxLines) break;
        records.push(...parseLine(line));
      }

      const title = deriveTitle(records, session.sessionId);

      if (!thread) {
        thread = createThread({
          agent_id: session.agentId,
          source: "openclaw_import",
          source_session_id: session.sessionId,
          title,
          metadata: {
            openclawImport: {
              mtimeMs: stat.mtimeMs,
              lineCount: lines.length,
            },
          },
        });
      } else if (opts.force) {
        // Drop existing messages to rebuild cleanly.
        for (const msg of listMessages({ threadId: thread.id, limit: 2000 })) {
          deleteMessage(msg.id);
        }
        thread =
          updateThread(thread.id, {
            title,
            metadata: {
              ...thread.metadata,
              openclawImport: {
                mtimeMs: stat.mtimeMs,
                lineCount: lines.length,
              },
            },
          }) ?? thread;
      } else {
        // Incremental append: skip the physical lines already imported.
        // `lineCount` was recorded as `lines.length`, so it doubles as the
        // offset for `i` in the next pass.
        const offset = existingMetaImport?.lineCount ?? 0;
        const newRecords: ParsedRecord[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (i < offset) continue;
          const line = lines[i];
          if (!line.trim()) continue;
          newRecords.push(...parseLine(line));
        }
        records.length = 0;
        records.push(...newRecords);
        thread =
          updateThread(thread.id, {
            title,
            metadata: {
              ...thread.metadata,
              openclawImport: {
                mtimeMs: stat.mtimeMs,
                lineCount: lines.length,
              },
            },
          }) ?? thread;
      }

      let added = 0;
      for (const record of records) {
        appendMessage({
          thread_id: thread.id,
          role: record.role,
          content: record.content,
          tool_name: record.tool_name ?? null,
          tool_input: record.tool_input ?? null,
          tool_output: record.tool_output ?? null,
          status: "complete",
        });
        added += 1;
      }

      // Mission Control activity log: one entry per *user turn* in the
      // newly-imported slice. Duration is the wall-clock gap to the next
      // assistant text in the same batch — captures Telegram / CLI / cron
      // conversations that never went through /api/chat/stream.
      for (let i = 0; i < records.length; i += 1) {
        const u = records[i];
        if (u.role !== "user" || !u.content.trim()) continue;
        let nextAssistant: ParsedRecord | undefined;
        for (let j = i + 1; j < records.length; j += 1) {
          if (records[j].role === "assistant" && records[j].content.trim()) {
            nextAssistant = records[j];
            break;
          }
        }
        const previewSrc = u.content.replace(/\s+/g, " ").trim();
        const preview =
          previewSrc.length > 80 ? `${previewSrc.slice(0, 77)}…` : previewSrc;
        const duration_ms = nextAssistant
          ? Math.max(
              0,
              new Date(nextAssistant.created_at).getTime() -
                new Date(u.created_at).getTime(),
            )
          : null;
        try {
          logActivity(
            "message",
            `OpenClaw: ${preview}`,
            nextAssistant ? "success" : "pending",
            {
              agent: session.agentId,
              duration_ms,
              metadata: {
                source: "openclaw_import",
                sessionId: session.sessionId,
                threadId: thread.id,
              },
            },
          );
        } catch {
          // Best-effort — never break the import on activity-log failure.
        }

        // Live Mission card for the orchestrator's own work (Telegram / CLI /
        // cron) so the board reflects what Jarvis does outside the web chat.
        // The web chat already creates its own cards; specialist runs are
        // covered by the task-worker — hence the orchestrator-only gate.
        if (ORCHESTRATOR_IDS.has(session.agentId) && isSubstantialTurn(u.content)) {
          try {
            const card = createTask({
              assigned_to: session.agentId,
              status: nextAssistant ? "done" : "in_progress",
              title: preview,
              prompt: u.content,
              metadata: {
                origin: "openclaw-import",
                source: session.sessionId.startsWith("telegram")
                  ? "telegram"
                  : "openclaw",
                sessionId: session.sessionId,
                threadId: thread.id,
              },
            });
            publishEvent({
              event_type: "task.created",
              task_id: card.id,
              agent_id: session.agentId,
              payload: { title: preview, source: "openclaw-import" },
            });
            if (nextAssistant) {
              const resultPreview = nextAssistant.content.slice(0, 2000);
              updateTask(card.id, { status: "done", result: resultPreview });
              publishEvent({
                event_type: "task.completed",
                task_id: card.id,
                agent_id: session.agentId,
                payload: { source: "openclaw-import" },
              });
            }
          } catch {
            // Best-effort — never break the import on card-creation failure.
          }
        }
      }

      summary.imported += 1;
      summary.threads.push({
        agentId: session.agentId,
        sessionId: session.sessionId,
        threadId: thread.id,
        messagesAdded: added,
      });
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
