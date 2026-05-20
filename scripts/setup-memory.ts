#!/usr/bin/env tsx
/**
 * Pre-warms the memory subsystem on fresh install.
 *
 *   - Triggers a one-time download of the Xenova embedding model
 *     (~30MB) so the first user-facing search isn't slow.
 *   - Initializes the SQLite memory store (data/memories.db).
 *   - Initializes the FTS5 markdown index (data/memory-fts.db) so
 *     the first /api/memory/search returns hits immediately.
 *
 * Idempotent: safe to run repeatedly. Designed to be invoked from
 * scripts/deploy.sh and as the post-install npm script
 * `npm run setup:memory`.
 *
 * Failure modes are intentionally soft: if the network is offline
 * or @xenova/transformers isn't installed yet, we log and exit 0
 * so the install pipeline keeps going. The runtime will lazy-load
 * on first use.
 */
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
const MODELS_DIR = path.join(DATA_DIR, "models");

async function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function initDatabases() {
  await ensureDir(DATA_DIR);
  try {
    // Import to trigger schema creation
    const { getStats } = await import("../src/lib/memory-db");
    const stats = getStats();
    console.log(
      `[setup-memory] memories.db ready (total=${stats.total}, cursors=${stats.cursors})`,
    );
  } catch (err) {
    console.warn("[setup-memory] memories.db init failed:", err);
  }
  try {
    const { getIndexStats } = await import("../src/lib/memory-fts");
    const stats = getIndexStats();
    console.log(
      `[setup-memory] memory-fts.db ready (files=${stats.totalFiles})`,
    );
  } catch (err) {
    console.warn("[setup-memory] memory-fts.db init failed:", err);
  }
}

async function prewarmEmbeddings() {
  await ensureDir(MODELS_DIR);
  try {
    const { getProvider } = await import("../src/lib/embeddings");
    console.log(
      "[setup-memory] downloading Xenova MiniLM-L6-v2 (~30MB)…",
    );
    const provider = await getProvider("xenova");
    console.log(
      `[setup-memory] embedding provider ready: ${provider.id}:${provider.modelId} (${provider.dim} dim)`,
    );
  } catch (err) {
    console.warn(
      "[setup-memory] embedding pre-warm skipped:",
      err instanceof Error ? err.message : err,
    );
    console.warn(
      "[setup-memory] the dashboard will boot fine — embeddings will lazy-load on first use",
    );
  }
}

async function main() {
  console.log("[setup-memory] starting…");
  await initDatabases();
  await prewarmEmbeddings();
  console.log("[setup-memory] done");
}

main().catch((err) => {
  console.error("[setup-memory] unexpected failure:", err);
  // Exit 0 — we don't want to break installs over a model download
  process.exit(0);
});
