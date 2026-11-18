/**
 * Memory extraction pipeline (v2).
 *
 * Source: chats.db — the canonical transcript store. The web chat writes
 * there directly and gateway sessions (Telegram, WhatsApp, CLI) are
 * imported by the sessions bridge; the bridge plugin will write there too.
 * Reading raw OpenClaw JSONL is fragile: since OpenClaw 2026.8 the live
 * transcript store is SQLite and JSONL is legacy/archive.
 *
 * For each thread with new, settled messages (idle ≥ 90s) we take a batch
 * of exchanges, show the LLM the most related memories that already exist,
 * and ask for operations — ADD / UPDATE / SUPERSEDE / NOOP — instead of a
 * blind list. That is what keeps the store from filling with duplicates
 * and lets corrections ("na verdade é X") replace stale facts.
 *
 * The LLM also returns entities, preferences, deliverables and a session
 * summary; the raw JSON is stored in extraction_runs so later phases
 * (client/brand model, preference learning) can use it without paying for
 * the same conversation twice.
 *
 * No heuristic fallback: if the LLM is unavailable the cursor does not
 * move and the job row records the error. A paraphrase of the user's
 * request is not a memory.
 */
import {
  ENTITY_TYPES,
  findMentionedEntities,
  getBrandKit,
  getEntity,
  invalidateMentionCache,
  linkMemoryToEntity,
  logDeliverable,
  upsertEntity,
  type EntityRow,
  type EntityType,
} from "@/lib/entity-db";
import {
  getChatCursor,
  setChatCursor,
  updateMemory,
  getMemoryById,
  getMemoriesByIds,
  createLink,
  recordExtractionRun,
  startJob,
  finishJob,
  getSettingValue,
  setSettingValue,
  type MemoryType,
  type MemoryRow,
} from "@/lib/memory-db";
import {
  listThreadsForExtraction,
  listMessagesAfterRowid,
  sqliteTimeToMs,
  toSqliteTime,
  type ChatSource,
  type ExtractionThreadRow,
  type MessageWithRowid,
} from "@/lib/chat-db";
import {
  addMemory,
  patchMemory,
  searchHybrid,
  workspaceForAgent,
  ownerDisplayName,
} from "@/lib/memory-service";
import {
  runOneShotJson,
  isOneShotAvailable,
  OneShotUnavailableError,
  ONESHOT_MARKER,
} from "@/lib/llm-oneshot";
import { isAgentBusy } from "@/lib/agent-activity";
import { isBridgeActive } from "@/lib/bridge-status";
import { ingestConversationPreferences } from "@/lib/preference-model";

/** Setting written by the v2 migration; threads idle since before it are
 *  left for the explicit backfill job instead of being re-billed here. */
export const ENGINE_V2_STARTED_AT_KEY = "memory_engine_v2_started_at";

/**
 * "telegram" = turns captured live by the bridge plugin (any gateway
 * channel); "openclaw_import" = the JSONL importer. While the plugin is
 * alive it is the authoritative feed, so imported copies of the same
 * conversations are skipped (no double learning).
 */
function extractSources(): ChatSource[] {
  return isBridgeActive() ? ["web", "telegram"] : ["web", "telegram", "openclaw_import"];
}
const DEFAULT_IDLE_MS = 90_000;
const BATCH_MAX_EXCHANGES = 8;
const BATCH_MAX_CHARS = 9_000;
const MSG_MAX_CHARS = 1_500;
const MAX_ATTEMPTS_PER_BATCH = 6;
const EXISTING_CONTEXT_K = 12;

// ─── Transcript cleanup ────────────────────────────────────────────────

/** Messages we must never learn from. */
const SKIP_EXCHANGE_RE = [
  new RegExp(ONESHOT_MARKER.replace(/[[\]]/g, "\\$&")),
  /\[atlas:worker\]/, // specialist task prompts (written by the orchestrator, not the user)
  /HEARTBEAT\.md|HEARTBEAT_OK/i,
  /^\s*\[cron[:\]]/i,
];

/** Remove AtlasDeck-injected scaffolding so only what the user said remains. */
export function cleanUserText(raw: string): string {
  return raw
    .replace(/<atlas-memory>[\s\S]*?<\/atlas-memory>/gi, "")
    .replace(/\[atlas:[a-z_]+\][^\n]*(?:\n(?!\n)[^\n]*)*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, max: number): string {
  const t = text.replace(/[ \t]+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

interface Exchange {
  firstRowid: number;
  lastRowid: number;
  user: string;
  assistant: string[];
  tools: string[];
  at: string;
}

/** Group messages into exchanges (a user turn + what followed it). */
export function groupExchanges(messages: MessageWithRowid[]): { exchanges: Exchange[]; lastRowid: number } {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  let lastRowid = 0;
  for (const m of messages) {
    lastRowid = m.rowid;
    if (m.role === "user") {
      if (current) exchanges.push(current);
      current = { firstRowid: m.rowid, lastRowid: m.rowid, user: m.content, assistant: [], tools: [], at: m.created_at };
      continue;
    }
    if (!current) continue; // assistant/tool output with no user turn before it
    current.lastRowid = m.rowid;
    if (m.role === "assistant" && m.content.trim()) current.assistant.push(m.content);
    else if (m.role === "tool_use" && m.tool_name) {
      const input = typeof m.tool_input === "string" ? m.tool_input : JSON.stringify(m.tool_input ?? "");
      current.tools.push(`${m.tool_name}(${clip(input, 160)})`);
    }
  }
  if (current) exchanges.push(current);
  return { exchanges, lastRowid };
}

function isLearnable(ex: Exchange): boolean {
  if (SKIP_EXCHANGE_RE.some((re) => re.test(ex.user))) return false;
  return cleanUserText(ex.user).length >= 2;
}

function renderExchange(ex: Exchange, owner: string): string {
  const parts = [`[${ex.at} UTC] ${owner.toUpperCase()}:\n${clip(cleanUserText(ex.user), MSG_MAX_CHARS)}`];
  if (ex.tools.length) parts.push(`FERRAMENTAS USADAS: ${ex.tools.slice(0, 6).join("; ")}`);
  const reply = ex.assistant.join("\n").trim();
  if (reply) parts.push(`ASSISTENTE:\n${clip(reply, MSG_MAX_CHARS)}`);
  return parts.join("\n");
}

// ─── Prompt + output contract ──────────────────────────────────────────

type OpKind = "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP";

export interface ExtractionOp {
  op: OpKind;
  target_id?: string | null;
  type?: MemoryType;
  title?: string;
  content?: string;
  importance?: number;
  tags?: string[];
  evidence?: string;
}

export interface ExtractionOutput {
  ops: ExtractionOp[];
  entities?: Array<Record<string, unknown>>;
  preferences?: Array<Record<string, unknown>>;
  deliverables?: Array<Record<string, unknown>>;
  session_summary?: string;
}

function isExtractionOutput(v: unknown): v is ExtractionOutput {
  return Boolean(v) && typeof v === "object" && Array.isArray((v as { ops?: unknown }).ops);
}

function buildPrompt(owner: string, existing: MemoryRow[], conversation: string): string {
  const known = existing.length
    ? existing
        .map((m) => `- id=${m.id} | ${m.type} | ${m.title} | ${clip(m.content, 300)}`)
        .join("\n")
    : "(nenhuma memória relacionada ainda)";

  return `${ONESHOT_MARKER}
Você é o módulo de memória de longo prazo de um assistente pessoal. Seu trabalho é decidir o que, desta conversa, vale lembrar daqui a semanas para atender ${owner} melhor — sem precisar repetir contexto.

MEMÓRIAS JÁ EXISTENTES (podem ser atualizadas ou substituídas):
${known}

CONVERSA (trecho mais recente):
<CONVERSA>
${conversation}
</CONVERSA>

O QUE MERECE MEMÓRIA
- Preferências e jeito de trabalhar de ${owner} (formato, tom, ferramentas, "sempre/nunca/prefiro/não gosto"). Correções que ${owner} fez no assistente são prioridade máxima.
- Fatos duráveis: quem é, empresa, clientes, projetos, pessoas, decisões tomadas, prazos e compromissos.
- Trabalho feito para um cliente/projeto (página, proposta, material, campanha): registre o cliente, o que foi feito, e a identidade visual / abordagem usada (cores com hex, fontes, tom, logo, referências, estrutura) — isso será reaproveitado depois.
- Procedimentos que funcionaram ("para publicar X faça A, B, C").

O QUE NÃO MERECE
- Cumprimentos, perguntas pontuais já respondidas, status momentâneo, conteúdo genérico.
- Sugestões do assistente que ${owner} não confirmou. Informação de terceiros que ${owner} não endossou.
- Nada que já esteja igual numa memória existente (use NOOP).

OPERAÇÕES
- ADD: fato novo.
- UPDATE: complementa ou corrige uma memória existente — informe target_id e o conteúdo FINAL completo.
- SUPERSEDE: a informação nova contradiz e substitui uma existente — informe target_id e o conteúdo novo.
- NOOP: nada a registrar (pode retornar "ops": []).

ESTILO
- Português do Brasil, terceira pessoa ("${owner} prefere…", "O cliente Acme usa…").
- Cada memória autocontida: nomes próprios explícitos, sem "ele/isso/aquele cliente". title ≤ 80 caracteres; content ≤ 450.
- type: semantic (fato/preferência durável), procedural (como fazer), identity (quem ${owner} é), episodic (algo que aconteceu e importa lembrar, com data).
- importance 0–1: 0.9 identidade ou "sempre/nunca"; 0.75 preferência clara ou dado de cliente; 0.5 útil; abaixo de 0.4 não registre.
- evidence: trecho literal curto da fala de ${owner} que justifica.
- Se ${owner} disser que NÃO quer ser perguntado sobre reaproveitar trabalhos/identidades anteriores, crie uma memória semantic com a tag "pref:no-reuse-prompt".

ENTIDADES E ENTREGÁVEIS (listas separadas, além das ops)
- entities: clientes, marcas, projetos, pessoas e organizações com quem ${owner} trabalha que aparecem na conversa. Use o nome próprio como ${owner} usa. Em "brand", só o que foi dito explicitamente (cores com hex, fontes, tom de voz, logo, referências). Se ${owner} CORRIGIR a identidade de um cliente, inclua a entidade com o "brand" já corrigido (a lista nova substitui a antiga).
- deliverables: o que foi produzido/pedido para alguém (página, site, proposta, post, apresentação, logo, e-mail, documento). "approach" = estrutura/estilo/tecnologia usados; "branding" = identidade visual aplicada; "client" = nome do cliente (vazio se for para ${owner} mesmo).
- preferences: preferências de ${owner} sobre como o assistente deve trabalhar.

Responda SOMENTE com JSON válido, sem markdown:
{"ops":[{"op":"ADD","target_id":null,"type":"semantic","title":"...","content":"...","importance":0.75,"tags":["..."],"evidence":"..."}],
 "entities":[{"type":"client|brand|project|person|organization","name":"...","aliases":[],"summary":"1 frase","brand":{"colors":["#123456"],"fonts":["..."],"tone":"...","logo":"...","references":[],"notes":"..."}}],
 "preferences":[{"pattern":"...","kind":"explicit|correction|implicit","scope":"global ou entity:<nome>","evidence":"..."}],
 "deliverables":[{"kind":"landing_page|site|proposta|post|apresentacao|logo|email|documento|outro","title":"...","client":"...","approach":"...","branding":"...","artifact":"caminho ou URL, se citado"}],
 "session_summary":"1-2 frases sobre o que foi tratado"}`;
}

// ─── Applying operations ───────────────────────────────────────────────

const VALID_TYPES: MemoryType[] = ["semantic", "procedural", "identity", "episodic"];

function sanitizeOp(raw: ExtractionOp): ExtractionOp | null {
  const op = String(raw.op || "").toUpperCase() as OpKind;
  if (!["ADD", "UPDATE", "SUPERSEDE", "NOOP"].includes(op)) return null;
  if (op === "NOOP") return { op };
  const title = String(raw.title || "").trim().slice(0, 200);
  const content = String(raw.content || "").trim().slice(0, 2000);
  if (!title || !content) return null;
  const importance = Math.min(1, Math.max(0, Number(raw.importance ?? 0.6)));
  if (op === "ADD" && importance < 0.4) return null;
  const type = VALID_TYPES.includes(raw.type as MemoryType) ? (raw.type as MemoryType) : "semantic";
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [];
  return {
    op,
    target_id: raw.target_id ? String(raw.target_id) : null,
    type,
    title,
    content,
    importance,
    tags,
    evidence: raw.evidence ? String(raw.evidence).slice(0, 300) : undefined,
  };
}

export interface ApplyStats {
  created: number;
  updated: number;
  superseded: number;
  noop: number;
  rejected: number;
  /** Memory ids created/updated by this batch (for entity linking). */
  touched: string[];
  entities: number;
  deliverables: number;
}

/**
 * Persist entities + deliverables the LLM reported, and link the batch's
 * memories to the entities they mention. Deterministic, no extra LLM call.
 */
function applyEntities(
  data: ExtractionOutput,
  ctx: { workspace: string; threadId: string },
  touchedIds: string[],
): { entities: number; deliverables: number } {
  let entities = 0;
  let deliverables = 0;
  const touched: EntityRow[] = [];
  for (const raw of (data.entities ?? []).slice(0, 15)) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length < 2) continue;
    const type = ENTITY_TYPES.includes(raw.type as EntityType) ? (raw.type as EntityType) : "organization";
    try {
      touched.push(
        upsertEntity({
          workspace: ctx.workspace,
          type,
          name,
          aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String).slice(0, 6) : undefined,
          summary: typeof raw.summary === "string" ? raw.summary : typeof raw.note === "string" ? raw.note : null,
          brand: raw.brand ?? (raw.attributes as Record<string, unknown> | undefined)?.brand,
          mention: true,
        }),
      );
      entities++;
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-extractor] entity failed:", err);
    }
  }
  for (const raw of (data.deliverables ?? []).slice(0, 10)) {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const kind = typeof raw.kind === "string" ? raw.kind : "outro";
    if (!title) continue;
    const artifact = typeof raw.artifact === "string" ? raw.artifact.trim() : "";
    try {
      const d = logDeliverable({
        workspace: ctx.workspace,
        kind,
        title,
        clientName: typeof raw.client === "string" ? raw.client : null,
        approach: typeof raw.approach === "string" ? raw.approach : null,
        branding: typeof raw.branding === "string" ? raw.branding : null,
        artifactUrl: /^https?:\/\//i.test(artifact) ? artifact : null,
        artifactPath: artifact && !/^https?:\/\//i.test(artifact) ? artifact : null,
        sourceThreadId: ctx.threadId,
      });
      // Branding described on the deliverable also enriches the client's kit.
      if (d.client_entity_id && typeof raw.branding === "string" && raw.branding.trim()) {
        const client = getEntity(d.client_entity_id);
        if (client && !getBrandKit(client)) {
          upsertEntity({ workspace: ctx.workspace, type: client.type, name: client.name, brand: raw.branding });
        }
      }
      deliverables++;
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-extractor] deliverable failed:", err);
    }
  }
  if (entities || deliverables) invalidateMentionCache();

  // Link memories ↔ entities by name mention.
  if (touchedIds.length) {
    for (const memory of getMemoriesByIds(touchedIds)) {
      for (const e of findMentionedEntities(ctx.workspace, `${memory.title}\n${memory.content}`)) {
        linkMemoryToEntity(memory.id, e.id);
      }
    }
  }
  return { entities, deliverables };
}

async function applyOps(
  ops: ExtractionOp[],
  ctx: { workspace: string; agentId: string; threadId: string; allowedTargets: Set<string> },
): Promise<ApplyStats> {
  const stats: ApplyStats = {
    created: 0,
    updated: 0,
    superseded: 0,
    noop: 0,
    rejected: 0,
    touched: [],
    entities: 0,
    deliverables: 0,
  };
  for (const raw of ops.slice(0, 20)) {
    const op = sanitizeOp(raw);
    if (!op) {
      stats.rejected++;
      continue;
    }
    if (op.op === "NOOP") {
      stats.noop++;
      continue;
    }
    // The model may only touch memories it was shown; anything else is
    // treated as a plain ADD (the dedupe in addMemory still applies).
    const target = op.target_id && ctx.allowedTargets.has(op.target_id) ? getMemoryById(op.target_id) : null;
    const tags = [...new Set([...(op.tags ?? []), "auto"])];

    try {
      if (op.op === "UPDATE" && target) {
        await patchMemory(target.id, {
          title: target.pinned ? undefined : op.title,
          content: op.content,
          importance: Math.max(target.importance, op.importance ?? 0),
          tags: [...new Set([...target.tags, ...tags])].slice(0, 12),
          archived: false,
        });
        stats.updated++;
        stats.touched.push(target.id);
        continue;
      }

      const result = await addMemory({
        workspace: ctx.workspace,
        agent_id: ctx.agentId,
        type: op.type ?? "semantic",
        title: op.title!,
        content: op.content!,
        summary: op.evidence ? `“${clip(op.evidence, 200)}”` : null,
        source: "extraction",
        source_session_id: ctx.threadId,
        // null (not the thread) so the same fact from another conversation
        // hits the (workspace, source, title) unique key and updates.
        source_file_path: null,
        tags,
        importance: op.importance,
        language: "pt-BR",
      });

      stats.touched.push(result.memory.id);
      if (op.op === "SUPERSEDE" && target && target.id !== result.memory.id) {
        updateMemory(target.id, { archived: true });
        createLink(result.memory.id, target.id, "supersedes", "llm", 1);
        stats.superseded++;
      } else if (result.action === "updated") {
        stats.updated++;
      } else {
        stats.created++;
      }
    } catch (err) {
      stats.rejected++;
      if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-extractor] apply failed:", err);
    }
  }
  return stats;
}

// ─── Per-thread processing ─────────────────────────────────────────────

export interface ThreadBatchResult {
  status: "processed" | "skipped" | "idle-wait" | "failed" | "empty";
  fromRowid: number;
  toRowid: number;
  exchanges: number;
  stats?: ApplyStats;
  error?: string;
}

/**
 * Process ONE batch of a thread (at most BATCH_MAX_EXCHANGES exchanges).
 * Moves the cursor only on success (or when nothing learnable was found).
 */
export async function extractThreadBatch(
  thread: Pick<ExtractionThreadRow, "id" | "agent_id">,
  opts: { idleMs?: number; force?: boolean } = {},
): Promise<ThreadBatchResult> {
  const cursor = getChatCursor(thread.id);
  const fromRowid = cursor?.last_rowid ?? 0;
  const messages = listMessagesAfterRowid(thread.id, fromRowid, 400);
  if (messages.length === 0) return { status: "empty", fromRowid, toRowid: fromRowid, exchanges: 0 };

  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const lastAt = sqliteTimeToMs(messages[messages.length - 1].created_at);
  if (!opts.force && Date.now() - lastAt < idleMs) {
    return { status: "idle-wait", fromRowid, toRowid: fromRowid, exchanges: 0 };
  }

  const { exchanges, lastRowid } = groupExchanges(messages);
  const owner = ownerDisplayName();

  // Take whole exchanges up to the char/exchange budget.
  const batch: Exchange[] = [];
  let chars = 0;
  let batchEnd = fromRowid;
  for (const ex of exchanges) {
    if (batch.length >= BATCH_MAX_EXCHANGES) break;
    const size = Math.min(ex.user.length, MSG_MAX_CHARS) + Math.min(ex.assistant.join("").length, MSG_MAX_CHARS);
    if (batch.length > 0 && chars + size > BATCH_MAX_CHARS) break;
    batch.push(ex);
    chars += size;
    batchEnd = ex.lastRowid;
  }
  // Messages before the first user turn (orphans) or a fully consumed list.
  if (batch.length === exchanges.length) batchEnd = Math.max(batchEnd, lastRowid);
  if (exchanges.length === 0) batchEnd = lastRowid;

  const learnable = batch.filter(isLearnable);
  const userChars = learnable.reduce((n, ex) => n + cleanUserText(ex.user).length, 0);
  // "oi", "ok", "valeu" alone never justify an LLM call.
  if (learnable.length === 0 || userChars < 12) {
    setChatCursor(thread.id, batchEnd, "ok");
    return { status: "skipped", fromRowid, toRowid: batchEnd, exchanges: batch.length };
  }

  const workspace = workspaceForAgent(thread.agent_id);
  const conversation = learnable.map((ex) => renderExchange(ex, owner)).join("\n\n---\n\n");
  const userText = learnable.map((ex) => cleanUserText(ex.user)).join("\n").slice(0, 2000);
  const existing = (
    await searchHybrid(userText, { workspace, k: EXISTING_CONTEXT_K, relevantOnly: false })
  ).map((h) => h.memory);

  const jobId = startJob("extract", `thread:${thread.id}:${fromRowid}-${batchEnd}`);
  try {
    const { data, strategy } = await runOneShotJson<ExtractionOutput>(buildPrompt(owner, existing, conversation), {
      purpose: "extract",
      validate: isExtractionOutput,
    });
    const stats = await applyOps(data.ops, {
      workspace,
      agentId: thread.agent_id,
      threadId: thread.id,
      allowedTargets: new Set(existing.map((m) => m.id)),
    });
    const ent = applyEntities(data, { workspace, threadId: thread.id }, stats.touched);
    stats.entities = ent.entities;
    stats.deliverables = ent.deliverables;
    try {
      ingestConversationPreferences(data.preferences ?? [], `thread:${thread.id}`);
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-extractor] preferences failed:", err);
    }
    recordExtractionRun({
      thread_id: thread.id,
      agent_id: thread.agent_id,
      workspace,
      from_rowid: fromRowid,
      to_rowid: batchEnd,
      provider: `openclaw:${strategy}`,
      output: data,
      applied_ops: stats.created + stats.updated + stats.superseded,
    });
    setChatCursor(thread.id, batchEnd, "ok");
    finishJob(jobId, "ok", {
      provider: `openclaw:${strategy}`,
      detail: `+${stats.created} ~${stats.updated} ⇄${stats.superseded} =${stats.noop} ✗${stats.rejected} entidades=${stats.entities} entregas=${stats.deliverables}`,
    });
    return { status: "processed", fromRowid, toRowid: batchEnd, exchanges: learnable.length, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(jobId, "failed", { error: message });
    if (err instanceof OneShotUnavailableError) {
      // Global outage: don't charge the thread an attempt.
      return { status: "failed", fromRowid, toRowid: fromRowid, exchanges: 0, error: message };
    }
    const attempts = (cursor?.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS_PER_BATCH) {
      // Poison batch: skip it so the rest of the thread isn't stuck forever.
      setChatCursor(thread.id, batchEnd, "ok", `skipped after ${attempts} failures: ${message}`);
    } else {
      setChatCursor(thread.id, fromRowid, "failed", message);
    }
    return { status: "failed", fromRowid, toRowid: fromRowid, exchanges: 0, error: message };
  }
}

// ─── Round (scheduler entry point) ─────────────────────────────────────

export interface ExtractionRoundResult {
  threadsConsidered: number;
  batches: number;
  created: number;
  updated: number;
  superseded: number;
  failed: number;
  stoppedReason: "done" | "budget" | "busy" | "llm-unavailable";
}

/**
 * One scheduler round. Processes up to `maxBatches` LLM calls across the
 * threads with pending messages, newest activity first. Stops early when
 * the user is talking to an agent (the memory LLM shares the gateway).
 */
export async function extractRecentConversations(opts: {
  maxBatches?: number;
  idleMs?: number;
  force?: boolean;
  /** Process only these threads (manual "extract now"). */
  threadIds?: string[];
} = {}): Promise<ExtractionRoundResult> {
  const result: ExtractionRoundResult = {
    threadsConsidered: 0,
    batches: 0,
    created: 0,
    updated: 0,
    superseded: 0,
    failed: 0,
    stoppedReason: "done",
  };
  const maxBatches = opts.maxBatches ?? 6;
  const engineStart = getSettingValue(ENGINE_V2_STARTED_AT_KEY);
  // Threads idle since before the engine started belong to the backfill.
  const activeSince = engineStart ? toSqliteTime(engineStart) : toSqliteTime(Date.now() - 24 * 3600_000);

  let threads = listThreadsForExtraction({ sources: extractSources(), activeSince, limit: 300 });
  if (opts.threadIds?.length) {
    const wanted = new Set(opts.threadIds);
    threads = listThreadsForExtraction({ sources: extractSources(), limit: 2000 }).filter((t) => wanted.has(t.id));
  }

  // Oldest pending first within the window, so nothing starves.
  const pending = threads
    .filter((t) => (getChatCursor(t.id)?.last_rowid ?? 0) < t.last_rowid)
    .sort((a, b) => sqliteTimeToMs(a.last_message_at) - sqliteTimeToMs(b.last_message_at));
  result.threadsConsidered = pending.length;

  for (const thread of pending) {
    // Drain this thread batch by batch while budget allows.
    for (;;) {
      if (result.batches >= maxBatches) {
        result.stoppedReason = "budget";
        return result;
      }
      if (!isOneShotAvailable()) {
        result.stoppedReason = "llm-unavailable";
        return result;
      }
      if (!opts.force && (await isAgentBusy())) {
        result.stoppedReason = "busy";
        return result;
      }
      const r = await extractThreadBatch(thread, { idleMs: opts.idleMs, force: opts.force });
      if (r.status === "processed") {
        result.batches++;
        result.created += r.stats?.created ?? 0;
        result.updated += r.stats?.updated ?? 0;
        result.superseded += r.stats?.superseded ?? 0;
        continue;
      }
      if (r.status === "skipped") continue; // cursor moved without an LLM call
      if (r.status === "failed") {
        result.batches++;
        result.failed++;
      }
      break; // empty, idle-wait or failed → next thread
    }
  }
  return result;
}

// ─── Backfill (re-learn the last N days with the v2 extractor) ─────────

export const BACKFILL_STATE_KEY = "memory_backfill_state";

export interface BackfillState {
  active: boolean;
  days: number;
  startedAt: string;
  batches: number;
  finishedAt?: string | null;
  lastError?: string | null;
}

export function getBackfillState(): BackfillState | null {
  const raw = getSettingValue(BACKFILL_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackfillState;
  } catch {
    return null;
  }
}

function setBackfillState(state: BackfillState): void {
  setSettingValue(BACKFILL_STATE_KEY, JSON.stringify(state));
}

function backfillCandidates(days: number): ExtractionThreadRow[] {
  const since = toSqliteTime(Date.now() - days * 86_400_000);
  // Always include imported sessions here: the history (Telegram up to the
  // OpenClaw SQLite migration) lives there, and it predates the bridge, so
  // there is no live copy to double-learn from.
  return listThreadsForExtraction({ sources: ["web", "telegram", "openclaw_import"], activeSince: since, limit: 2000 })
    .filter((t) => (getChatCursor(t.id)?.last_rowid ?? 0) < t.last_rowid)
    .sort((a, b) => sqliteTimeToMs(a.last_message_at) - sqliteTimeToMs(b.last_message_at));
}

/** Rough size of a backfill: threads, pending messages, ≈LLM calls. */
export function estimateBackfill(days = 90): { threads: number; messages: number; estimatedCalls: number } {
  let messages = 0;
  const threads = backfillCandidates(days);
  for (const t of threads) {
    messages += listMessagesAfterRowid(t.id, getChatCursor(t.id)?.last_rowid ?? 0, 2000).filter(
      (m) => m.role === "user",
    ).length;
  }
  return { threads: threads.length, messages, estimatedCalls: Math.ceil(messages / BATCH_MAX_EXCHANGES) };
}

export function startBackfill(days = 90): BackfillState {
  const state: BackfillState = { active: true, days, startedAt: new Date().toISOString(), batches: 0, finishedAt: null };
  setBackfillState(state);
  return state;
}

export function stopBackfill(): BackfillState | null {
  const s = getBackfillState();
  if (!s) return null;
  const next = { ...s, active: false, finishedAt: new Date().toISOString() };
  setBackfillState(next);
  return next;
}

/**
 * One backfill slice (called by the scheduler after the regular round).
 * Oldest conversations first so newer facts supersede older ones.
 * Same guards as the regular rounds: idle agent, LLM available.
 */
export async function runBackfillSlice(maxBatches = 4): Promise<{ batches: number; done: boolean }> {
  const state = getBackfillState();
  if (!state?.active) return { batches: 0, done: true };
  let batches = 0;
  for (const thread of backfillCandidates(state.days)) {
    while (batches < maxBatches) {
      if (!isOneShotAvailable() || (await isAgentBusy())) {
        setBackfillState({ ...state, batches: state.batches + batches });
        return { batches, done: false };
      }
      const r = await extractThreadBatch(thread, { force: true });
      if (r.status === "processed" || r.status === "failed") batches++;
      if (r.status === "failed") {
        setBackfillState({ ...state, batches: state.batches + batches, lastError: r.error ?? null });
        return { batches, done: false };
      }
      if (r.status !== "processed" && r.status !== "skipped") break;
    }
    if (batches >= maxBatches) {
      setBackfillState({ ...state, batches: state.batches + batches });
      return { batches, done: false };
    }
  }
  setBackfillState({ ...state, batches: state.batches + batches, active: false, finishedAt: new Date().toISOString() });
  return { batches, done: true };
}

// ─── Recall formatting (used by the MEMORY.md injector) ────────────────

/**
 * Format memories as a recall block. Includes a clipped `content` — the
 * old version printed only titles, so the agent saw "Cores do cliente
 * Acme" but never the colors.
 */
export function buildPromptBlock(memories: MemoryRow[], contentChars = 220): string {
  if (memories.length === 0) return "";
  const grouped: Record<MemoryType, MemoryRow[]> = {
    identity: [],
    semantic: [],
    procedural: [],
    episodic: [],
  };
  for (const m of memories) grouped[m.type].push(m);

  const labels: Record<MemoryType, string> = {
    identity: "Quem é o usuário",
    semantic: "Fatos e preferências",
    procedural: "Como fazer",
    episodic: "Acontecimentos",
  };
  const sections: string[] = [];
  for (const type of ["identity", "semantic", "procedural", "episodic"] as MemoryType[]) {
    const list = grouped[type];
    if (list.length === 0) continue;
    sections.push(`### ${labels[type]}`);
    for (const m of list) {
      const body = clip(m.content || m.summary || "", contentChars);
      sections.push(body && body !== m.title ? `- **${m.title}** — ${body}` : `- **${m.title}**`);
    }
  }
  return sections.join("\n");
}
