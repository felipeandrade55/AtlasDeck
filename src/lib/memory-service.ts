/**
 * Memory service: the one place that knows how to search and write
 * memories well. Used by the extractor, the MCP tools (over HTTP), the
 * recall injector and the per-turn context builder.
 *
 *  - searchHybrid: keyword (FTS5/bm25) + semantic (cosine) fused with
 *    Reciprocal Rank Fusion, weighted by importance, gated by a
 *    model-aware relevance floor so "nothing relevant" returns nothing.
 *  - addMemory: embeds, and if a near-identical memory of the same type
 *    already exists, updates it instead of creating a duplicate.
 */
import {
  upsertMemory,
  updateMemory,
  getMemoryById,
  getMemoriesByIds,
  searchSimilar,
  searchMemoriesFts,
  setMemoryEmbedding,
  autoLinkMemory,
  listMemoriesNeedingEmbedding,
  getSettings,
  type MemoryInsert,
  type MemoryRow,
  type MemoryType,
  type MemoryUpdate,
} from "@/lib/memory-db";
import { embedPassage, embedQuery, type EmbeddedVector } from "@/lib/embeddings";
import { currentEmbeddingModelTag, similarityThresholds } from "@/lib/embedding-config";

/** Convention shared with the MCP server and the injector. */
export function workspaceForAgent(agentId: string | null | undefined): string {
  return !agentId || agentId === "main" ? "workspace" : `workspace-${agentId}`;
}

/** Display name for prompts — never a hardcoded person (SaaS-safe). */
export function ownerDisplayName(): string {
  try {
    return getSettings().owner_name?.trim() || "o usuário";
  } catch {
    return "o usuário";
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function tryEmbedQuery(text: string, timeoutMs = 5000): Promise<EmbeddedVector | null> {
  try {
    return await withTimeout(embedQuery(text), timeoutMs, "embedQuery");
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-service] embedQuery failed:", err);
    return null;
  }
}

export async function tryEmbedPassage(text: string, timeoutMs = 15000): Promise<EmbeddedVector | null> {
  try {
    return await withTimeout(embedPassage(text), timeoutMs, "embedPassage");
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") console.warn("[memory-service] embedPassage failed:", err);
    return null;
  }
}

export function memoryEmbeddingText(m: { title: string; content: string; tags?: string[] }): string {
  const tags = m.tags && m.tags.length ? `\n${m.tags.join(", ")}` : "";
  return `${m.title}\n${m.content}${tags}`;
}

// ─── Search ────────────────────────────────────────────────────────────

export interface HybridHit {
  memory: MemoryRow;
  score: number;
  cosine: number | null;
  keyword: boolean;
}

export interface HybridSearchOptions {
  workspace?: string;
  type?: MemoryType | MemoryType[];
  k?: number;
  /** Drop hits that fail the relevance floor (default true). */
  relevantOnly?: boolean;
  excludeIds?: string[];
  /** Pre-computed query vector (skip embedding). */
  vector?: EmbeddedVector | null;
}

const RRF_K = 60;

export async function searchHybrid(query: string, opts: HybridSearchOptions = {}): Promise<HybridHit[]> {
  const text = query.trim();
  if (!text) return [];
  const k = Math.min(Math.max(opts.k ?? 8, 1), 50);
  const relevantOnly = opts.relevantOnly ?? true;
  const th = similarityThresholds();
  const exclude = new Set(opts.excludeIds ?? []);

  const vector = opts.vector === undefined ? await tryEmbedQuery(text) : opts.vector;

  const cosById = new Map<string, number>();
  const vecRank = new Map<string, number>();
  if (vector) {
    const hits = searchSimilar(vector.vector, {
      workspace: opts.workspace,
      type: opts.type,
      k: 40,
      minScore: 0,
      model: vector.model,
    });
    hits.forEach((h, i) => {
      cosById.set(h.memory.id, h.score);
      vecRank.set(h.memory.id, i);
    });
  }

  const ftsRank = new Map<string, number>();
  searchMemoriesFts(text, { workspace: opts.workspace, type: opts.type, limit: 40 }).forEach((h, i) =>
    ftsRank.set(h.id, i),
  );

  const ids = new Set<string>([...vecRank.keys(), ...ftsRank.keys()]);
  const candidates = getMemoriesByIds([...ids].filter((id) => !exclude.has(id)));

  const out: HybridHit[] = [];
  for (const memory of candidates) {
    const cos = cosById.get(memory.id) ?? null;
    const keyword = ftsRank.has(memory.id);
    if (relevantOnly) {
      const hasCurrentVector = memory.embedding_model === (vector?.model ?? currentEmbeddingModelTag());
      const semanticOk = cos !== null && cos >= th.relevant;
      // Keyword-only matches are trusted when we can't judge semantically
      // (no query vector, or memory not yet re-embedded), or when the
      // semantic score is close to the floor.
      const keywordOk =
        keyword && (!vector || !hasCurrentVector || (cos !== null && cos >= th.relevant - 0.05));
      if (!semanticOk && !keywordOk) continue;
    }
    let rrf = 0;
    const vr = vecRank.get(memory.id);
    const fr = ftsRank.get(memory.id);
    if (vr !== undefined) rrf += 1 / (RRF_K + vr);
    if (fr !== undefined) rrf += 1 / (RRF_K + fr);
    const score = rrf * (0.75 + 0.25 * (memory.importance ?? 0.5)) + (memory.pinned ? 0.002 : 0);
    out.push({ memory, score, cosine: cos, keyword });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

// ─── Write ─────────────────────────────────────────────────────────────

export type AddAction = "created" | "updated";

export interface AddMemoryResult {
  memory: MemoryRow;
  action: AddAction;
  /** When action = "updated" by dedupe: similarity with the existing row. */
  similarity?: number;
}

function unionTags(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b].map((t) => t.trim()).filter(Boolean))].slice(0, 12);
}

/**
 * Create a memory, or merge into a near-duplicate of the same type in the
 * same workspace (newer wording wins, importance never decreases, tags
 * are unioned). Embedding + auto-linking are best-effort.
 */
export async function addMemory(
  input: MemoryInsert,
  opts: { dedupe?: boolean } = {},
): Promise<AddMemoryResult> {
  const dedupe = opts.dedupe ?? true;
  const embed = await tryEmbedPassage(memoryEmbeddingText(input));

  if (dedupe && embed) {
    const [dup] = searchSimilar(embed.vector, {
      workspace: input.workspace,
      type: input.type,
      k: 1,
      minScore: similarityThresholds(embed.model).duplicate,
      model: embed.model,
    });
    if (dup) {
      const existing = dup.memory;
      const merged = updateMemory(existing.id, {
        content: input.content,
        summary: input.summary ?? existing.summary,
        importance: Math.max(existing.importance, input.importance ?? 0.5),
        tags: unionTags(existing.tags, input.tags),
        pinned: existing.pinned || Boolean(input.pinned),
        archived: false,
      });
      setMemoryEmbedding(existing.id, embed.vector, embed.model, embed.dim);
      return { memory: merged ?? existing, action: "updated", similarity: dup.score };
    }
  }

  const row = upsertMemory({
    ...input,
    embedding: embed?.vector ?? null,
    embedding_model: embed?.model ?? null,
    embedding_dim: embed?.dim ?? null,
  });
  if (embed) {
    // upsert's ON CONFLICT path writes the embedding too, but be explicit.
    setMemoryEmbedding(row.id, embed.vector, embed.model, embed.dim);
    try {
      autoLinkMemory(row.id);
    } catch {
      /* linking is cosmetic */
    }
  }
  return { memory: getMemoryById(row.id) ?? row, action: "created" };
}

/** Patch a memory and refresh its vector when the text changed. */
export async function patchMemory(id: string, patch: MemoryUpdate): Promise<MemoryRow | null> {
  const row = updateMemory(id, patch);
  if (!row) return null;
  if (patch.title !== undefined || patch.content !== undefined || patch.tags !== undefined) {
    const embed = await tryEmbedPassage(memoryEmbeddingText(row));
    if (embed) setMemoryEmbedding(row.id, embed.vector, embed.model, embed.dim);
  }
  return getMemoryById(id);
}

/**
 * Re-embed memories that have no vector or one from an older model.
 * Called in small batches by the scheduler so it never hogs the CPU.
 */
export async function reembedPending(limit = 25): Promise<{ done: number; failed: number }> {
  const rows = listMemoriesNeedingEmbedding(limit);
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const embed = await tryEmbedPassage(memoryEmbeddingText(row), 30_000);
    if (!embed) {
      failed++;
      continue;
    }
    setMemoryEmbedding(row.id, embed.vector, embed.model, embed.dim);
    done++;
  }
  return { done, failed };
}
