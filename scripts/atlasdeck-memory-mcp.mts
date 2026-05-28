#!/usr/bin/env -S npx tsx
/**
 * atlasdeck-memory: MCP server (stdio) that gives the OpenClaw agent
 * a real, first-class memory tool — so "Salvei na memória" becomes
 * the truth, not a hallucination.
 *
 * Registered with OpenClaw via ~/.openclaw/mcp.json. Reads/writes the
 * same SQLite database that the AtlasDeck UI shows
 * (data/memories.db relative to ATLASDECK_ROOT), so anything the agent
 * saves shows up in the dashboard immediately, and vice-versa.
 *
 * Required env (set by mcp.json):
 *   ATLASDECK_ROOT       — absolute path to the AtlasDeck checkout
 *                          (used to locate data/memories.db and models)
 *   OPENCLAW_AGENT_ID    — defaults to "main"
 *   ATLASDECK_WORKSPACE  — defaults to "workspace" (matches the
 *                          convention in src/lib/memory-extractor.ts
 *                          where agent "main" → workspace "workspace")
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Use stderr exclusively for human-readable logs — stdout is the
// JSON-RPC channel the MCP transport speaks on. Defined FIRST so
// every boot step can log, including pre-chdir failures.
function log(msg: string, extra?: unknown): void {
  if (extra !== undefined) {
    process.stderr.write(`[atlasdeck-memory] ${msg} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`[atlasdeck-memory] ${msg}\n`);
  }
}

// Top-level safety net: an unhandled throw from any sync init code
// crashes the MCP server with exit code 1, and OpenClaw (depending
// on version) may then refuse to spawn the agent at all. Catching
// here lets us log the cause to stderr — which OpenClaw captures —
// instead of dying silently.
process.on("uncaughtException", (err) => {
  log("uncaughtException", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
process.on("unhandledRejection", (err) => {
  log("unhandledRejection", err instanceof Error ? err.message : String(err));
  process.exit(3);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const envRoot = process.env.ATLASDECK_ROOT
  ? path.resolve(process.env.ATLASDECK_ROOT)
  : null;
const fallbackRoot = path.resolve(here, "..");

log(`boot start. envRoot=${envRoot ?? "<unset>"} fallbackRoot=${fallbackRoot}`);

// Resolve a usable AtlasDeck root: prefer env, but fall back to the
// script's own parent dir if env points to nowhere. This survives
// the worst-case scenario of mcp.json being written on host A and
// the script running on host B with a different checkout location.
function resolveAtlasdeckRoot(): string {
  if (envRoot && fs.existsSync(envRoot)) return envRoot;
  if (envRoot && !fs.existsSync(envRoot)) {
    log(`ATLASDECK_ROOT=${envRoot} does not exist — falling back to script dir`);
  }
  if (fs.existsSync(fallbackRoot)) return fallbackRoot;
  log("FATAL: neither ATLASDECK_ROOT nor fallback root exists");
  process.exit(4);
}

const atlasdeckRoot = resolveAtlasdeckRoot();

// memory-db, embeddings, etc. all resolve their data dir from
// process.cwd(). Pin cwd to the AtlasDeck root before any of those
// modules are imported so the MCP server shares the same SQLite
// file/model cache as the Next.js server.
try {
  process.chdir(atlasdeckRoot);
} catch (err) {
  log("chdir failed", err instanceof Error ? err.message : String(err));
  process.exit(5);
}

// Verify the SQLite file or its parent dir is reachable — better-sqlite3
// will create the file lazily, but if the data dir is unwritable the
// first DB call inside a tool handler will throw and confuse the agent
// far more than failing here would.
const dataDir = path.join(atlasdeckRoot, "data");
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    log("could not create data dir", err instanceof Error ? err.message : String(err));
    process.exit(6);
  }
}

const AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";
const WORKSPACE =
  process.env.ATLASDECK_WORKSPACE ||
  (AGENT_ID === "main" ? "workspace" : `workspace-${AGENT_ID}`);

log(`boot ok. root=${atlasdeckRoot} agent=${AGENT_ID} workspace=${WORKSPACE}`);

// Dynamic imports happen AFTER chdir so memory-db.ts and embeddings.ts
// resolve their data dir from the right process.cwd(). The .mts
// extension forces tsx into ESM mode, which is what makes top-level
// await available (CJS transpile rejects it).
let McpServer: typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
let StdioServerTransport: typeof import("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport;
let z: typeof import("zod").z;
let memoryDb: typeof import("../src/lib/memory-db");
let embeddings: typeof import("../src/lib/embeddings");
let remindersDb: typeof import("../src/lib/reminders-db");

try {
  ({ McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"));
  ({ StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  ));
  ({ z } = await import("zod"));
  memoryDb = await import("../src/lib/memory-db");
  embeddings = await import("../src/lib/embeddings");
  remindersDb = await import("../src/lib/reminders-db");
} catch (err) {
  log("module load failed", err instanceof Error ? err.message : String(err));
  process.exit(7);
}

const {
  upsertMemory,
  setMemoryEmbedding,
  searchSimilar,
  listMemories,
  updateMemory,
  deleteMemory,
  getMemoryById,
  getStats,
  recordAccess,
} = memoryDb;
type MemoryRow = import("../src/lib/memory-db").MemoryRow;
const { embedTexts } = embeddings;

const MemoryTypeSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "identity",
]);

function summarizeRow(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    importance: row.importance,
    tags: row.tags,
    pinned: row.pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function asJson(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function asError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

// Embedding lifecycle is the riskiest part of cold start: the first
// call to embedTexts() downloads ~30MB of Xenova model and unpacks
// the inference pipeline. That can take 30-90 seconds on a fresh
// install, and during that window the MCP tool handler would block
// — long enough for OpenClaw to time out and kill the child, which
// makes the agent unresponsive on Telegram. So we:
//   1. Kick off a single warmup in the BACKGROUND right after boot
//      so the first user-facing tool call sees a hot pipeline.
//   2. Cap any individual embed at 8s. Past that, fall back to
//      saving without a vector — search degrades to LIKE matching
//      but the memory is still persisted and surfaced in the UI.
//   3. Surface progress to stderr so the diagnose view shows it.
let embeddingsReady = false;
let embeddingsError: string | null = null;
let embeddingsPromise: Promise<void> | null = null;

function startEmbeddingsWarmup(): void {
  if (embeddingsPromise) return;
  log("warming up embeddings in background (first run downloads ~30MB)");
  const warmupStart = Date.now();
  embeddingsPromise = (async () => {
    try {
      await embedTexts(["warmup"]);
      embeddingsReady = true;
      log(`embeddings ready (${Date.now() - warmupStart}ms)`);
    } catch (err) {
      embeddingsError = err instanceof Error ? err.message : String(err);
      log(`embeddings warmup failed — falling back to LIKE search: ${embeddingsError}`);
    }
  })();
}

const EMBED_TIMEOUT_MS = 8000;

async function tryEmbed(text: string): Promise<{
  vector: Float32Array;
  model: string;
  dim: number;
} | null> {
  // If warmup is still in flight, give it a brief chance — but never
  // longer than the tool-level timeout. Idle queues don't help us
  // here; OpenClaw is waiting on this Promise.
  if (!embeddingsReady && embeddingsPromise) {
    try {
      await Promise.race([
        embeddingsPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("warmup-timeout")), EMBED_TIMEOUT_MS),
        ),
      ]);
    } catch {
      return null;
    }
  }
  if (embeddingsError) return null;

  try {
    const result = await Promise.race([
      embedTexts([text]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("embed-timeout")), EMBED_TIMEOUT_MS),
      ),
    ]);
    if (result.vectors.length === 0) return null;
    return {
      vector: result.vectors[0],
      model: `${result.provider.id}:${result.provider.modelId}`,
      dim: result.provider.dim,
    };
  } catch (err) {
    // Embeddings are best-effort. The memory is still saved without
    // a vector — search will degrade to LIKE-style lookups for it.
    log(
      "embedding failed (saving without vector)",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

const server = new McpServer({
  name: "atlasdeck-memory",
  version: "0.1.0",
});

server.registerTool(
  "memory_add",
  {
    title: "Save a memory",
    description:
      "Persist a durable fact for future sessions. Use when the user explicitly asks to remember something, OR when you notice something worth retaining without being asked (preferences, recurring constraints, personal context, project decisions). Returns the saved memory id.",
    inputSchema: {
      type: MemoryTypeSchema.describe(
        "episodic = something that happened. semantic = durable fact/preference. procedural = how-to. identity = who the user is.",
      ),
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short label (≤200 chars). Used for deduplication."),
      content: z
        .string()
        .min(1)
        .max(4000)
        .describe("Full memory body (≤4000 chars)."),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "0.0–1.0. Default 0.7 for agent-saved memories. Use ≥0.85 when the user said 'always/never/remember' or it's identity-level.",
        ),
      tags: z.array(z.string()).max(12).optional(),
      language: z
        .string()
        .min(2)
        .max(12)
        .optional()
        .describe("e.g. pt-BR, en. Detect from content."),
      summary: z.string().max(280).optional(),
      pinned: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const embed = await tryEmbed(`${args.title}\n${args.content}`);
      const row = upsertMemory({
        workspace: WORKSPACE,
        agent_id: AGENT_ID,
        type: args.type,
        title: args.title.trim(),
        content: args.content.trim(),
        summary: args.summary?.trim() || null,
        source: "agent",
        tags: args.tags,
        importance: args.importance ?? 0.7,
        pinned: args.pinned ?? false,
        language: args.language ?? null,
        embedding_model: embed?.model ?? null,
        embedding_dim: embed?.dim ?? null,
        embedding: embed?.vector ?? null,
      });
      if (embed && !row.embedding_model) {
        // upsertMemory ON CONFLICT does write the embedding, but be
        // defensive in case a future caller passes embedding=null on
        // update — make sure it gets attached.
        setMemoryEmbedding(row.id, embed.vector, embed.model, embed.dim);
      }
      return asJson({ ok: true, memory: summarizeRow(row) });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "memory_search",
  {
    title: "Search memories",
    description:
      "Semantic search over all stored memories using embeddings. Call this BEFORE answering questions where past context might be relevant ('what did I say about X', 'lembre-se', 'você sabe meu...'). Returns top-k hits with similarity scores.",
    inputSchema: {
      query: z.string().min(1).max(500),
      k: z.number().int().min(1).max(20).optional(),
      type: MemoryTypeSchema.optional(),
    },
  },
  async (args) => {
    try {
      const embed = await tryEmbed(args.query);
      if (!embed) {
        // Fallback: LIKE search via listMemories
        const result = listMemories({
          workspace: WORKSPACE,
          search: args.query,
          type: args.type,
          limit: args.k ?? 10,
          sort: "importance",
        });
        return asJson({
          mode: "fallback-text",
          hits: result.memories.map((m) => ({
            score: null,
            memory: summarizeRow(m),
          })),
        });
      }
      const hits = searchSimilar(embed.vector, {
        workspace: WORKSPACE,
        type: args.type,
        k: args.k ?? 8,
        minScore: 0.25,
      });
      for (const h of hits) recordAccess(h.memory.id);
      return asJson({
        mode: "semantic",
        hits: hits.map((h) => ({
          score: Number(h.score.toFixed(4)),
          memory: summarizeRow(h.memory),
        })),
      });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "memory_get",
  {
    title: "Read full memory by id",
    description:
      "Fetch the full content of a single memory (use after memory_search returns a hit you want to expand).",
    inputSchema: { id: z.string().min(1) },
  },
  async (args) => {
    const row = getMemoryById(args.id);
    if (!row) return asError(`memory ${args.id} not found`);
    recordAccess(row.id);
    return asJson({
      ...summarizeRow(row),
      content: row.content,
      source: row.source,
    });
  },
);

server.registerTool(
  "memory_list_recent",
  {
    title: "List recent memories",
    description:
      "List the most recent memories (any source). Useful when the user asks 'o que você sabe sobre mim' or you want a snapshot.",
    inputSchema: {
      k: z.number().int().min(1).max(50).optional(),
      type: MemoryTypeSchema.optional(),
    },
  },
  async (args) => {
    const result = listMemories({
      workspace: WORKSPACE,
      type: args.type,
      limit: args.k ?? 15,
      archived: false,
      sort: "created",
    });
    return asJson({
      total: result.total,
      memories: result.memories.map(summarizeRow),
    });
  },
);

server.registerTool(
  "memory_update",
  {
    title: "Update a memory",
    description:
      "Patch an existing memory (correct facts, raise importance, re-tag, pin). Use when the user says 'na verdade é X' or 'sempre lembre desse'.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(4000).optional(),
      summary: z.string().max(280).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).max(12).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    },
  },
  async (args) => {
    const { id, ...patch } = args;
    const row = updateMemory(id, patch);
    if (!row) return asError(`memory ${id} not found`);
    // If content/title changed, regenerate the embedding so future
    // searches reflect the new wording.
    if (patch.title || patch.content) {
      const embed = await tryEmbed(`${row.title}\n${row.content}`);
      if (embed) {
        setMemoryEmbedding(row.id, embed.vector, embed.model, embed.dim);
      }
    }
    return asJson({ ok: true, memory: summarizeRow(row) });
  },
);

server.registerTool(
  "memory_remove",
  {
    title: "Delete a memory",
    description:
      "Permanently remove a memory by id. Use when the user explicitly says to forget something. Prefer memory_update({archived: true}) for soft removal.",
    inputSchema: { id: z.string().min(1) },
  },
  async (args) => {
    const ok = deleteMemory(args.id);
    if (!ok) return asError(`memory ${args.id} not found`);
    return asJson({ ok: true, deleted: args.id });
  },
);

server.registerTool(
  "memory_stats",
  {
    title: "Memory store stats",
    description:
      "Summary counters: total memories, breakdown by type, last extraction time. Useful for self-reporting ('quantas coisas você lembra sobre mim').",
    inputSchema: {},
  },
  async () => {
    return asJson(getStats());
  },
);

server.registerTool(
  "reminder_add",
  {
    title: "Add a reminder",
    description: "Create a new quick reminder or task on the user's dashboard. Use when the user asks to remember something, remind them, or write down a quick note/task.",
    inputSchema: {
      text: z.string().min(1).describe("The content of the reminder (e.g., 'Pagar a conta X', 'Corrigir bug no sistema')."),
      due_at: z.string().optional().describe("Optional ISO datetime string for when this is due or when to be reminded (e.g., '2026-05-29T14:00:00Z')."),
    },
  },
  async (args) => {
    try {
      const row = remindersDb.createReminder({
        text: args.text.trim(),
        due_at: args.due_at || null,
      });
      return asJson({ ok: true, reminder: row });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "reminder_list",
  {
    title: "List reminders",
    description: "Retrieve all quick reminders from the database, both pending and completed.",
    inputSchema: {},
  },
  async () => {
    try {
      const rows = remindersDb.listAllReminders();
      return asJson({ ok: true, reminders: rows });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "reminder_update",
  {
    title: "Update a reminder",
    description: "Modify an existing reminder. Use when the user wants to edit, postpone, change description, complete, or reschedule a reminder. IMPORTANT: You must first list all reminders using `reminder_list` to search for the target reminder by description, get its UUID `id`, and then invoke this tool with that ID and the desired changes.",
    inputSchema: {
      id: z.string().min(1).describe("The unique UUID of the reminder to update."),
      text: z.string().optional().describe("Optional new description/text for the reminder."),
      completed: z.boolean().optional().describe("Optional completion status (true to complete, false to keep pending)."),
      due_at: z.string().nullable().optional().describe("Optional ISO datetime string for when this is due, or null to clear it."),
    },
  },
  async (args) => {
    try {
      const { id, ...patch } = args;
      const row = remindersDb.updateReminder(id, patch);
      if (!row) return asError(`reminder ${id} not found`);
      return asJson({ ok: true, reminder: row });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "reminder_remove",
  {
    title: "Delete a reminder",
    description: "Permanently delete/remove a quick reminder. IMPORTANT: You must first list all reminders using `reminder_list` to search for the target reminder by description, get its UUID `id`, and then invoke this tool with that ID.",
    inputSchema: {
      id: z.string().min(1).describe("The unique UUID of the reminder to delete."),
    },
  },
  async (args) => {
    try {
      const ok = remindersDb.deleteReminder(args.id);
      if (!ok) return asError(`reminder ${args.id} not found`);
      return asJson({ ok: true, deleted: args.id });
    } catch (err) {
      return asError(err instanceof Error ? err.message : String(err));
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready (stdio transport)");

  // Kick off embedding warmup AFTER signaling ready so OpenClaw sees
  // the MCP child healthy immediately. The download/inference setup
  // happens in the background — first user-facing tool call will be
  // hot if it lands after warmup completes, or fall back gracefully
  // (LIKE search, no-vector save) if it arrives during the download.
  startEmbeddingsWarmup();
}

main().catch((err) => {
  log("fatal", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
