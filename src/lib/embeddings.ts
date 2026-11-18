/**
 * Pluggable embedding provider.
 *
 * Default: Xenova/multilingual-e5-small running locally via
 * @xenova/transformers (quantized ONNX). No API key, no network calls
 * after the initial model download (cached at data/models/).
 *
 * The module is intentionally lazy: nothing is loaded until the first
 * embed() call, so the app boots and serves UI even if the model
 * hasn't been pre-downloaded.
 *
 * Only ONE pipeline instance per process: concurrent first calls share
 * the same in-flight load (the VPS has little RAM; two copies of the
 * model is exactly how we got OOM-killed before).
 */
import path from "path";
import { checkIsCostLocked } from "@/lib/usage-queries";
import { initDatabase } from "@/lib/usage-collector";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  embeddingModelTag,
  usesE5Prefixes,
  type EmbeddingKind,
} from "@/lib/embedding-config";

export interface EmbeddingProvider {
  id: string;
  modelId: string;
  dim: number;
  isLocal: boolean;
  embed(texts: string[], kind?: EmbeddingKind): Promise<Float32Array[]>;
  ready(): Promise<boolean>;
}

const MODEL_CACHE_DIR = path.join(process.cwd(), "data", "models");

const COST_DB_PATH = path.join(process.cwd(), "data", "usage-tracking.db");

/** e5 truncates at 512 tokens; keep inputs well under that. */
const MAX_INPUT_CHARS = 1800;

const _xenovaProviders = new Map<string, Promise<EmbeddingProvider>>();

async function buildXenovaProvider(modelId: string): Promise<EmbeddingProvider> {
  // Lazy-import only when needed so a fresh install can boot without the
  // model being available yet.
  type TransformersModule = {
    env: { allowLocalModels: boolean; cacheDir: string };
    pipeline: (
      task: string,
      modelId: string,
      options?: { quantized?: boolean },
    ) => Promise<
      (input: string, options: { pooling: string; normalize: boolean }) => Promise<{
        data: Float32Array | number[];
      }>
    >;
  };
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — optional dep; types not resolved at compile time
  const mod: TransformersModule = await import("@xenova/transformers");
  mod.env.allowLocalModels = true;
  mod.env.cacheDir = MODEL_CACHE_DIR;

  const extractor = await mod.pipeline("feature-extraction", modelId, { quantized: true });
  const e5 = usesE5Prefixes(modelId);

  const prepare = (text: string, kind: EmbeddingKind): string => {
    const safe = (text || "").replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS) || " ";
    return e5 ? `${kind}: ${safe}` : safe;
  };

  // Detect dimensionality from a probe.
  const probe = await extractor(prepare("dimension probe", "passage"), {
    pooling: "mean",
    normalize: true,
  });
  const probeArr = probe.data instanceof Float32Array
    ? probe.data
    : new Float32Array(probe.data as number[]);
  const dim = probeArr.length;

  return {
    id: "xenova",
    modelId,
    dim,
    isLocal: true,
    async embed(texts: string[], kind: EmbeddingKind = "passage") {
      const out: Float32Array[] = [];
      for (const t of texts) {
        const result = await extractor(prepare(t, kind), {
          pooling: "mean",
          normalize: true,
        });
        const arr =
          result.data instanceof Float32Array
            ? result.data
            : new Float32Array(result.data as number[]);
        out.push(arr);
      }
      return out;
    },
    async ready() {
      return true;
    },
  };
}

async function resolveProvider(providerId: string, modelId?: string): Promise<EmbeddingProvider> {
  if (providerId === "xenova") {
    const id = modelId || DEFAULT_EMBEDDING_MODEL;
    let pending = _xenovaProviders.get(id);
    if (!pending) {
      pending = buildXenovaProvider(id);
      _xenovaProviders.set(id, pending);
      // A failed load must not poison the cache forever.
      pending.catch(() => _xenovaProviders.delete(id));
    }
    return pending;
  }
  throw new Error(`Unknown embedding provider: ${providerId}`);
}

/**
 * Public entrypoint. Resolves the configured provider, applies cost
 * gating for paid providers, embeds, returns the vectors.
 *
 * `kind` matters for e5 models: stored memories are "passage", search
 * queries are "query". Defaults to passage (what most callers store).
 */
export async function embedTexts(
  texts: string[],
  providerId = DEFAULT_EMBEDDING_PROVIDER,
  modelId?: string,
  kind: EmbeddingKind = "passage",
): Promise<{ vectors: Float32Array[]; provider: EmbeddingProvider }> {
  const provider = await resolveProvider(providerId, modelId);

  if (!provider.isLocal) {
    const db = initDatabase(COST_DB_PATH);
    try {
      if (checkIsCostLocked(db)) {
        throw new Error("Cost lock active — paid embeddings blocked");
      }
    } finally {
      db.close();
    }
  }

  const vectors = await provider.embed(texts, kind);
  return { vectors, provider };
}

export interface EmbeddedVector {
  vector: Float32Array;
  /** `${provider}:${model}` — what gets stored in memories.embedding_model. */
  model: string;
  dim: number;
}

/** Embed one search query (uses the "query: " prefix on e5 models). */
export async function embedQuery(text: string): Promise<EmbeddedVector> {
  const { vectors, provider } = await embedTexts([text], DEFAULT_EMBEDDING_PROVIDER, undefined, "query");
  return { vector: vectors[0], model: embeddingModelTag(provider.id, provider.modelId), dim: provider.dim };
}

/** Embed one document/memory body for storage. */
export async function embedPassage(text: string): Promise<EmbeddedVector> {
  const { vectors, provider } = await embedTexts([text], DEFAULT_EMBEDDING_PROVIDER, undefined, "passage");
  return { vector: vectors[0], model: embeddingModelTag(provider.id, provider.modelId), dim: provider.dim };
}

export async function getProvider(
  providerId = DEFAULT_EMBEDDING_PROVIDER,
  modelId?: string,
): Promise<EmbeddingProvider> {
  return resolveProvider(providerId, modelId);
}

/**
 * Pre-warm: returns true if the model is ready, false if the host
 * doesn't have @xenova/transformers installed yet. Used by the
 * scheduler to skip extraction silently rather than crashing.
 */
export async function isEmbeddingReady(providerId = DEFAULT_EMBEDDING_PROVIDER): Promise<boolean> {
  try {
    await resolveProvider(providerId);
    return true;
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[embeddings] provider not ready:", err);
    }
    return false;
  }
}
