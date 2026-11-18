/**
 * Embedding model configuration shared by the DB layer, the search
 * service and the embedding provider. Kept dependency-free so
 * memory-db.ts can import it without pulling @xenova/transformers.
 *
 * Default model: multilingual-e5-small (384 dims, same as the previous
 * all-MiniLM-L6-v2, so the schema is unchanged). MiniLM was trained on
 * English; most of what users say here is PT-BR, which made semantic
 * recall miss obvious matches ("paleta" vs "cores da marca").
 *
 * e5 models expect "query: " / "passage: " prefixes and produce a
 * compressed cosine range (unrelated text often scores ~0.75), so every
 * similarity threshold must be model-aware — see `similarityThresholds`.
 */

export const DEFAULT_EMBEDDING_PROVIDER = "xenova";

export const DEFAULT_EMBEDDING_MODEL =
  process.env.ATLAS_EMBEDDING_MODEL || "Xenova/multilingual-e5-small";

export type EmbeddingKind = "query" | "passage";

export function embeddingModelTag(
  provider = DEFAULT_EMBEDDING_PROVIDER,
  model = DEFAULT_EMBEDDING_MODEL,
): string {
  return `${provider}:${model}`;
}

/** Tag of the model new vectors are written with. Searches only compare
 *  vectors with this tag so stale vectors from an older model (same dim,
 *  different space) never produce garbage similarities. */
export function currentEmbeddingModelTag(): string {
  return embeddingModelTag();
}

export function usesE5Prefixes(model: string): boolean {
  return /(^|\/)(multilingual-)?e5-/i.test(model);
}

export interface SimilarityThresholds {
  /** Minimum cosine for a hit to count as relevant to a query. */
  relevant: number;
  /** Cosine above which two memories are linked as "related". */
  related: number;
  /** Cosine above which two memories are considered the same fact. */
  duplicate: number;
}

function envFloat(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Starting points, not gospel: tune per deployment with the
 * ATLAS_SIM_* env vars after looking at real recall logs.
 *
 * Measured with multilingual-e5-small on PT-BR (test suite):
 *   paraphrase of a stored fact ("cores da marca" ↔ "azul #123456…") 0.85–0.90
 *   unrelated query ("receita de bolo") vs the same memories         ~0.82
 */
export function similarityThresholds(modelTag = currentEmbeddingModelTag()): SimilarityThresholds {
  const base: SimilarityThresholds = usesE5Prefixes(modelTag)
    ? { relevant: 0.83, related: 0.86, duplicate: 0.93 }
    : { relevant: 0.35, related: 0.5, duplicate: 0.9 };
  return {
    relevant: envFloat("ATLAS_SIM_RELEVANT") ?? base.relevant,
    related: envFloat("ATLAS_SIM_RELATED") ?? base.related,
    duplicate: envFloat("ATLAS_SIM_DUPLICATE") ?? base.duplicate,
  };
}
