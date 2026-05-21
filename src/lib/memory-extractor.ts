/**
 * Memory extraction pipeline.
 *
 * Reads new JSONL exchanges from a session, runs them through an
 * extraction function (LLM via OpenClaw CLI when available, simple
 * heuristic fallback otherwise), embeds the resulting candidates, and
 * persists them into the memories table. Maintains a cursor per
 * session so re-runs are idempotent.
 */
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  getCursor,
  setCursor,
  upsertMemory,
  setMemoryEmbedding,
  searchSimilar,
  createLink,
  getSettings,
  type MemoryType,
  type MemoryRow,
  type ExtractorProvider,
} from "@/lib/memory-db";
import {
  parseSessionExchanges,
  renderExchange,
  type SessionExchange,
} from "@/lib/session-parser";
import { embedTexts } from "@/lib/embeddings";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { generateJson as ollamaGenerateJson } from "@/lib/ollama-client";

const execFileAsync = promisify(execFile);

const OPENCLAW_TIMEOUT_MS = 45_000;
const OPENCLAW_MAX_BUFFER = 4 * 1024 * 1024;

const EXTRACTION_PROMPT_TEMPLATE = `Você é um extrator de memórias para um agente IA.

Analise o trecho de conversa abaixo (entre <CONVERSATION> e </CONVERSATION>) e extraia memórias estruturadas que valha a pena reter para futuras interações com o mesmo usuário.

Tipos válidos:
- episodic: fatos concretos sobre o que aconteceu nesta sessão (evento, decisão, bug fix)
- semantic: conhecimento durável sobre o usuário/projeto (preferências, contexto, definições)
- procedural: padrões de "como fazer" (workflow, convenção, técnica preferida)
- identity: informação sobre quem o usuário/agente é

Regras:
- Importance entre 0.0 (descartável) e 1.0 (crucial)
- Use linguagem do usuário (PT-BR ou EN — detecte)
- Title em ≤80 caracteres, content em ≤400 caracteres
- Evite duplicar informação trivial; foque no que seria útil saber no futuro
- Saída obrigatória em JSON válido, formato exato abaixo

Formato de saída (apenas JSON, sem markdown wrapper):
{"memories":[{"type":"semantic","title":"...","content":"...","summary":"...","importance":0.7,"tags":["..."],"language":"pt-BR"}]}

<CONVERSATION>
{{CONVERSATION}}
</CONVERSATION>`;

export interface ExtractionCandidate {
  type: MemoryType;
  title: string;
  content: string;
  summary?: string;
  importance: number;
  tags?: string[];
  language?: string;
}

export interface ExtractionContext {
  workspace: string;
  agentId: string;
  sessionId: string;
  sourceFilePath: string;
}

export interface ExtractionResult {
  extracted: number;
  linked: number;
  skipped: number;
  exchangesProcessed: number;
}

const HEURISTIC_BLOCKLIST = new Set([
  "ok",
  "obrigado",
  "thanks",
  "thank you",
  "sim",
  "yes",
  "no",
  "não",
  "ola",
  "olá",
  "oi",
  "hi",
  "hey",
]);

function shouldKeepUserMessage(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  if (trimmed.length < 20) return false;
  if (HEURISTIC_BLOCKLIST.has(trimmed)) return false;
  return true;
}

function summarize(content: string, maxLen = 140): string {
  const single = content.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Heuristic extraction: builds episodic candidates from user
 * messages, no LLM needed. Always works as a fallback so the system
 * remains useful even before OpenClaw integration is verified.
 */
function extractWithHeuristics(
  exchanges: SessionExchange[],
): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];

  for (const exchange of exchanges) {
    const userMsg = exchange.messages.find((m) => m.role === "user");
    if (!userMsg) continue;
    if (!shouldKeepUserMessage(userMsg.content)) continue;

    const assistantMsgs = exchange.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join(" ");

    const summary = summarize(userMsg.content);
    out.push({
      type: "episodic",
      title: summary.slice(0, 80),
      content: `Usuário pediu: "${summarize(userMsg.content, 240)}"${
        assistantMsgs ? `\nResposta sintetizada: ${summarize(assistantMsgs, 240)}` : ""
      }`,
      summary,
      importance: 0.4,
      tags: ["heuristic"],
    });
  }

  return out;
}

async function tryOpenClawExtraction(
  text: string,
): Promise<ExtractionCandidate[] | null> {
  const config = readOpenClawConfig();
  const prompt = EXTRACTION_PROMPT_TEMPLATE.replace("{{CONVERSATION}}", text);

  // Try a few plausible CLI signatures. The first one that returns
  // parseable JSON wins. Users can later configure the exact command
  // via MEMORY_EXTRACTION_CMD if their OpenClaw version differs.
  const overrideCmd = process.env.MEMORY_EXTRACTION_CMD;
  const candidates: string[][] = overrideCmd
    ? [overrideCmd.split(" ")]
    : [
        ["ask", "--json", "--prompt", prompt],
        ["chat", "--json", prompt],
        ["complete", "--json", prompt],
      ];

  for (const args of candidates) {
    try {
      const { stdout } = await execFileAsync(config.openclawBin, args, {
        timeout: OPENCLAW_TIMEOUT_MS,
        maxBuffer: OPENCLAW_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DIR: config.openclawDir,
          OPENCLAW_WORKSPACE: config.openclawWorkspace,
        },
      });

      const cleaned = String(stdout).trim();
      // Tolerant JSON extraction: model might wrap in ```json ... ```
      const jsonText = extractJsonObject(cleaned);
      if (!jsonText) continue;

      const parsed = JSON.parse(jsonText) as {
        memories?: ExtractionCandidate[];
      };
      if (Array.isArray(parsed.memories)) {
        return parsed.memories;
      }
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn(
          `[memory-extractor] OpenClaw call failed with ${args[0]}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return null;
}

async function tryOllamaExtraction(
  text: string,
  model: string,
): Promise<ExtractionCandidate[] | null> {
  const prompt = EXTRACTION_PROMPT_TEMPLATE.replace("{{CONVERSATION}}", text);
  try {
    const raw = await ollamaGenerateJson(model, prompt, {
      temperature: 0.2,
      maxTokens: 1024,
    });
    const jsonText = extractJsonObject(raw) ?? raw;
    const parsed = JSON.parse(jsonText) as {
      memories?: ExtractionCandidate[];
    };
    if (Array.isArray(parsed.memories)) return parsed.memories;
    return null;
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[memory-extractor] Ollama call failed:", err);
    }
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  // Strip code fences if present
  const fenceMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Otherwise grab outermost {...}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function sanitizeCandidate(
  raw: ExtractionCandidate,
): ExtractionCandidate | null {
  const validTypes: MemoryType[] = [
    "episodic",
    "semantic",
    "procedural",
    "identity",
  ];
  if (!validTypes.includes(raw.type)) return null;
  const title = String(raw.title || "").trim().slice(0, 200);
  const content = String(raw.content || "").trim().slice(0, 4000);
  if (!title || !content) return null;
  const importance = Math.min(
    1,
    Math.max(0, Number(raw.importance ?? 0.5)),
  );
  return {
    type: raw.type,
    title,
    content,
    summary: raw.summary
      ? String(raw.summary).trim().slice(0, 280)
      : summarize(content),
    importance,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(String).slice(0, 12)
      : undefined,
    language: raw.language ? String(raw.language).slice(0, 12) : undefined,
  };
}

export async function extractMemoriesForSession(
  filePath: string,
  ctx: ExtractionContext,
  opts: {
    batchExchanges?: number;
    useLLM?: boolean;
    provider?: ExtractorProvider;
    ollamaModel?: string;
  } = {},
): Promise<ExtractionResult> {
  const batchSize = opts.batchExchanges ?? 6;
  const useLLM = opts.useLLM ?? true;

  // Resolve provider from settings unless caller forced one
  const settings = getSettings();
  const provider: ExtractorProvider =
    opts.provider ?? settings.extractor_provider;
  const ollamaModel = opts.ollamaModel ?? settings.ollama_model;

  let cursor = getCursor(ctx.sessionId);
  if (!cursor) {
    cursor = {
      session_id: ctx.sessionId,
      agent_id: ctx.agentId,
      file_path: filePath,
      last_line: 0,
      last_processed_at: new Date().toISOString(),
      bytes_seen: 0,
    };
  }

  const parsed = await parseSessionExchanges(filePath, {
    fromLine: cursor.last_line + 1,
    maxExchanges: batchSize,
    truncateChars: 1200,
  });

  if (parsed.exchanges.length === 0) {
    return { extracted: 0, linked: 0, skipped: 0, exchangesProcessed: 0 };
  }

  let candidates: ExtractionCandidate[] = [];

  if (useLLM && provider !== "heuristic") {
    const rendered = parsed.exchanges.map(renderExchange).join("\n\n---\n\n");
    let llmOut: ExtractionCandidate[] | null = null;
    if (provider === "ollama") {
      llmOut = await tryOllamaExtraction(rendered, ollamaModel);
      // Auto-fallback: if Ollama is the preferred provider but failed
      // (not running, model missing, timeout), try OpenClaw so we don't
      // lose this extraction batch.
      if (!llmOut) {
        llmOut = await tryOpenClawExtraction(rendered);
      }
    } else {
      llmOut = await tryOpenClawExtraction(rendered);
      // Auto-fallback the other direction: premium provider failed
      // (no tokens, network), keep extracting via the local model.
      if (!llmOut) {
        llmOut = await tryOllamaExtraction(rendered, ollamaModel);
      }
    }
    if (llmOut && llmOut.length > 0) {
      candidates = llmOut;
    }
  }

  if (candidates.length === 0) {
    candidates = extractWithHeuristics(parsed.exchanges);
  }

  let extracted = 0;
  let linked = 0;
  let skipped = 0;

  for (const raw of candidates) {
    const clean = sanitizeCandidate(raw);
    if (!clean) {
      skipped++;
      continue;
    }

    try {
      const memory = upsertMemory({
        workspace: ctx.workspace,
        agent_id: ctx.agentId,
        type: clean.type,
        title: clean.title,
        content: clean.content,
        summary: clean.summary,
        source: "extraction",
        source_session_id: ctx.sessionId,
        source_file_path: ctx.sourceFilePath,
        tags: clean.tags,
        importance: clean.importance,
        language: clean.language,
      });
      extracted++;

      try {
        const { vectors, provider } = await embedTexts(
          [`${memory.title}\n${memory.content}`],
        );
        setMemoryEmbedding(
          memory.id,
          vectors[0],
          `${provider.id}:${provider.modelId}`,
          provider.dim,
        );

        const similar = searchSimilar(vectors[0], {
          workspace: ctx.workspace,
          excludeIds: [memory.id],
          k: 5,
          minScore: 0.85,
        });
        for (const hit of similar) {
          if (createLink(memory.id, hit.memory.id, "related", "cosine", hit.score)) {
            linked++;
          }
        }
      } catch (embedErr) {
        if (process.env.MEMORY_DEBUG === "1") {
          console.warn(
            "[memory-extractor] embed/link failed for",
            memory.id,
            embedErr,
          );
        }
      }
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory-extractor] upsert failed:", err);
      }
      skipped++;
    }
  }

  setCursor({
    session_id: ctx.sessionId,
    agent_id: ctx.agentId,
    file_path: filePath,
    last_line: parsed.lastLine,
    last_processed_at: new Date().toISOString(),
    bytes_seen: parsed.bytesSeen,
  });

  return {
    extracted,
    linked,
    skipped,
    exchangesProcessed: parsed.exchanges.length,
  };
}

/**
 * Walk the OpenClaw agents/<id>/sessions/ trees and extract memories
 * from every session JSONL whose mtime is newer than its cursor.
 */
export async function extractRecentSessions(opts: {
  maxSessions?: number;
  batchExchanges?: number;
  useLLM?: boolean;
  provider?: ExtractorProvider;
  ollamaModel?: string;
} = {}): Promise<{
  sessionsProcessed: number;
  extracted: number;
  linked: number;
  skipped: number;
  errors: number;
}> {
  const config = readOpenClawConfig();
  const agentsDir = path.join(config.openclawDir, "agents");

  let sessionsProcessed = 0;
  let extracted = 0;
  let linked = 0;
  let skipped = 0;
  let errors = 0;

  let agentEntries: string[];
  try {
    agentEntries = await fs.readdir(agentsDir);
  } catch {
    return { sessionsProcessed: 0, extracted: 0, linked: 0, skipped: 0, errors: 0 };
  }

  const maxSessions = opts.maxSessions ?? 50;

  for (const agentId of agentEntries) {
    if (sessionsProcessed >= maxSessions) break;
    const sessionsDir = path.join(agentsDir, agentId, "sessions");

    let sessionFiles: string[];
    try {
      sessionFiles = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }

    const jsonlFiles: Array<{ name: string; mtimeMs: number }> = [];
    for (const f of sessionFiles) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const stat = await fs.stat(path.join(sessionsDir, f));
        jsonlFiles.push({ name: f, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const workspace = agentId === "main" ? "workspace" : `workspace-${agentId}`;

    for (const file of jsonlFiles) {
      if (sessionsProcessed >= maxSessions) break;
      const sessionId = file.name.replace(/\.jsonl$/, "");
      const filePath = path.join(sessionsDir, file.name);

      const cursor = getCursor(sessionId);
      if (cursor && cursor.last_processed_at) {
        const lastMs = Date.parse(cursor.last_processed_at);
        if (Number.isFinite(lastMs) && file.mtimeMs <= lastMs) continue;
      }

      try {
        const result = await extractMemoriesForSession(
          filePath,
          { workspace, agentId, sessionId, sourceFilePath: filePath },
          {
            batchExchanges: opts.batchExchanges,
            useLLM: opts.useLLM,
            provider: opts.provider,
            ollamaModel: opts.ollamaModel,
          },
        );
        sessionsProcessed++;
        extracted += result.extracted;
        linked += result.linked;
        skipped += result.skipped;
      } catch (err) {
        errors++;
        if (process.env.MEMORY_DEBUG === "1") {
          console.warn(
            "[memory-extractor] session failed",
            filePath,
            err,
          );
        }
      }
    }
  }

  return { sessionsProcessed, extracted, linked, skipped, errors };
}

/**
 * Convenience: format selected memories as a recall prompt block ready
 * to be prepended to an agent system prompt or written to AUTO_RECALL.md.
 */
export function buildPromptBlock(memories: MemoryRow[]): string {
  if (memories.length === 0) return "";
  const grouped: Record<MemoryType, MemoryRow[]> = {
    identity: [],
    semantic: [],
    procedural: [],
    episodic: [],
  };
  for (const m of memories) grouped[m.type].push(m);

  const sections: string[] = [];
  const labels: Record<MemoryType, string> = {
    identity: "Identidade",
    semantic: "Conhecimento durável",
    procedural: "Padrões / How-to",
    episodic: "Eventos recentes",
  };

  for (const type of ["identity", "semantic", "procedural", "episodic"] as MemoryType[]) {
    const list = grouped[type];
    if (list.length === 0) continue;
    sections.push(`### ${labels[type]}`);
    for (const m of list) {
      const head = m.summary || m.title;
      sections.push(`- **${m.title}** — ${head}`);
    }
  }

  return sections.join("\n");
}
