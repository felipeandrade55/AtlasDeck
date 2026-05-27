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
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const atlasdeckRoot = process.env.ATLASDECK_ROOT
  ? path.resolve(process.env.ATLASDECK_ROOT)
  : path.resolve(here, "..");

// memory-db, embeddings, etc. all resolve their data dir from
// process.cwd(). Pin cwd to the AtlasDeck root before any of those
// modules are imported so the MCP server shares the same SQLite
// file/model cache as the Next.js server.
process.chdir(atlasdeckRoot);

const AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";
const WORKSPACE =
  process.env.ATLASDECK_WORKSPACE ||
  (AGENT_ID === "main" ? "workspace" : `workspace-${AGENT_ID}`);

// Use stderr exclusively for human-readable logs — stdout is the
// JSON-RPC channel the MCP transport speaks on.
function log(msg: string, extra?: unknown): void {
  if (extra !== undefined) {
    process.stderr.write(`[atlasdeck-memory] ${msg} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`[atlasdeck-memory] ${msg}\n`);
  }
}

log(`booting. root=${atlasdeckRoot} agent=${AGENT_ID} workspace=${WORKSPACE}`);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  upsertMemory,
  setMemoryEmbedding,
  searchSimilar,
  listMemories,
  updateMemory,
  deleteMemory,
  getMemoryById,
  getStats,
  recordAccess,
  type MemoryRow,
  type MemoryType,
} from "../src/lib/memory-db";
import { embedTexts } from "../src/lib/embeddings";

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

async function tryEmbed(text: string): Promise<{
  vector: Float32Array;
  model: string;
  dim: number;
} | null> {
  try {
    const { vectors, provider } = await embedTexts([text]);
    if (vectors.length === 0) return null;
    return {
      vector: vectors[0],
      model: `${provider.id}:${provider.modelId}`,
      dim: provider.dim,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready (stdio transport)");
}

main().catch((err) => {
  log("fatal", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
