/**
 * Pluggable embedding provider.
 *
 * Default: Xenova/all-MiniLM-L6-v2 running locally via
 * @xenova/transformers. No API key, no network calls after the
 * initial ~30MB model download (cached at data/models/).
 *
 * The module is intentionally lazy: nothing is loaded until the first
 * embed() call, so the app boots and serves UI even if the model
 * hasn't been pre-downloaded.
 *
 * Future providers (OpenAI, Voyage, Cohere, Ollama) plug in by
 * implementing EmbeddingProvider and registering in `resolveProvider`.
 */
import path from "path";
import { checkIsCostLocked } from "@/lib/usage-queries";
import { initDatabase } from "@/lib/usage-collector";

export interface EmbeddingProvider {
  id: string;
  modelId: string;
  dim: number;
  isLocal: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
  ready(): Promise<boolean>;
}

const MODEL_CACHE_DIR = path.join(process.cwd(), "data", "models");

const COST_DB_PATH = path.join(process.cwd(), "data", "usage-tracking.db");

let _xenovaProvider: EmbeddingProvider | null = null;

async function buildXenovaProvider(
  modelId = "Xenova/all-MiniLM-L6-v2",
): Promise<EmbeddingProvider> {
  // Lazy-import only when needed so a fresh install can boot without the
  // model being available yet.
  type TransformersModule = {
    env: { allowLocalModels: boolean; cacheDir: string };
    pipeline: (
      task: string,
      modelId: string,
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

  const extractor = await mod.pipeline("feature-extraction", modelId);

  // Detect dimensionality from a probe.
  const probe = await extractor("dimension probe", {
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
    async embed(texts: string[]) {
      const out: Float32Array[] = [];
      for (const t of texts) {
        const safe = (t || "").trim() || " ";
        const result = await extractor(safe, {
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
    if (_xenovaProvider && (!modelId || _xenovaProvider.modelId === modelId)) {
      return _xenovaProvider;
    }
    _xenovaProvider = await buildXenovaProvider(modelId);
    return _xenovaProvider;
  }
  throw new Error(`Unknown embedding provider: ${providerId}`);
}

/**
 * Public entrypoint. Resolves the configured provider, applies cost
 * gating for paid providers, embeds, returns the vectors.
 */
export async function embedTexts(
  texts: string[],
  providerId = "xenova",
  modelId?: string,
): Promise<{ vectors: Float32Array[]; provider: EmbeddingProvider }> {
  const provider = await resolveProvider(providerId, modelId);

  if (!provider.isLocal) {
    try {
      const db = initDatabase(COST_DB_PATH);
      try {
        if (checkIsCostLocked(db)) {
          throw new Error("Cost lock active — paid embeddings blocked");
        }
      } finally {
        db.close();
      }
    } catch (err) {
      // If cost DB is unavailable, fail closed for paid providers
      throw err;
    }
  }

  const vectors = await provider.embed(texts);
  return { vectors, provider };
}

export async function getProvider(
  providerId = "xenova",
  modelId?: string,
): Promise<EmbeddingProvider> {
  return resolveProvider(providerId, modelId);
}

/**
 * Pre-warm: returns true if the model is ready, false if the host
 * doesn't have @xenova/transformers installed yet. Used by the
 * scheduler to skip extraction silently rather than crashing.
 */
export async function isEmbeddingReady(providerId = "xenova"): Promise<boolean> {
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
