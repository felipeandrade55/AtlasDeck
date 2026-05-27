#!/usr/bin/env -S npx tsx
/**
 * Smoke test for the atlasdeck-memory MCP server.
 *
 * Spawns the server over stdio, exercises the full tool surface
 * (add → search → get → update → remove), prints a pass/fail
 * summary, and cleans up. No OpenClaw needed.
 *
 * Run: npm run smoke-test:mcp
 */
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const atlasdeckRoot = path.resolve(here, "..");
const serverScript = path.resolve(here, "atlasdeck-memory-mcp.ts");

interface Step {
  name: string;
  run: () => Promise<void>;
}

let passed = 0;
let failed = 0;

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function ok(msg: string): void {
  passed++;
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string, err?: unknown): void {
  failed++;
  console.log(`  ✗ ${msg}`);
  if (err) console.log(`      ${err instanceof Error ? err.message : String(err)}`);
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

function textPayload(result: unknown): string {
  const r = result as ToolResultLike;
  const part = r.content?.find((c) => c.type === "text");
  return typeof part?.text === "string" ? part.text : "";
}

function parsePayload<T>(result: unknown): T {
  return JSON.parse(textPayload(result)) as T;
}

async function main(): Promise<void> {
  console.log("atlasdeck-memory MCP smoke test\n");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverScript],
    env: {
      ...process.env,
      ATLASDECK_ROOT: atlasdeckRoot,
      OPENCLAW_AGENT_ID: "smoke-test",
      ATLASDECK_WORKSPACE: "smoke-test",
    },
  });

  const client = new Client({ name: "smoke-test", version: "0.0.0" });

  await client.connect(transport);
  ok("connected to MCP server");

  let createdId: string | null = null;
  const probeTitle = `Smoke test entry ${Date.now()}`;

  const steps: Step[] = [
    {
      name: "listTools returns the 7 memory tools",
      async run() {
        const result = await client.listTools();
        const names = result.tools.map((t) => t.name).sort();
        const expected = [
          "memory_add",
          "memory_get",
          "memory_list_recent",
          "memory_remove",
          "memory_search",
          "memory_stats",
          "memory_update",
        ];
        const missing = expected.filter((e) => !names.includes(e));
        if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
        log(`tools: ${names.join(", ")}`);
      },
    },
    {
      name: "memory_add creates a new entry",
      async run() {
        const raw = await client.callTool({
          name: "memory_add",
          arguments: {
            type: "semantic",
            title: probeTitle,
            content:
              "Quando publicar páginas, sempre devolver o link HTTPS público. " +
              "Esta entrada é apenas teste de smoke do MCP atlasdeck-memory.",
            importance: 0.9,
            tags: ["smoke-test", "preference"],
            language: "pt-BR",
          },
        });
        const payload = parsePayload<{
          ok: boolean;
          memory: { id: string; importance: number; type: string };
        }>(raw);
        if (!payload.ok || !payload.memory?.id) {
          throw new Error(`unexpected: ${JSON.stringify(payload)}`);
        }
        if (payload.memory.importance !== 0.9) {
          throw new Error(`importance not preserved: ${payload.memory.importance}`);
        }
        createdId = payload.memory.id;
        log(`id=${createdId}`);
      },
    },
    {
      name: "memory_search finds the entry semantically",
      async run() {
        const raw = await client.callTool({
          name: "memory_search",
          arguments: {
            query: "publicar página link público https",
            k: 5,
          },
        });
        const payload = parsePayload<{
          mode: string;
          hits: Array<{ score: number | null; memory: { id: string; title: string } }>;
        }>(raw);
        log(`mode=${payload.mode} hits=${payload.hits.length}`);
        const hit = payload.hits.find((h) => h.memory.id === createdId);
        if (!hit) throw new Error("created memory not returned in search");
      },
    },
    {
      name: "memory_get expands the entry",
      async run() {
        if (!createdId) throw new Error("no id from previous step");
        const raw = await client.callTool({
          name: "memory_get",
          arguments: { id: createdId },
        });
        const payload = parsePayload<{ id: string; content: string }>(raw);
        if (payload.id !== createdId) throw new Error("id mismatch");
        if (!payload.content.includes("HTTPS")) throw new Error("content not echoed");
      },
    },
    {
      name: "memory_update patches importance and pins",
      async run() {
        if (!createdId) throw new Error("no id");
        const raw = await client.callTool({
          name: "memory_update",
          arguments: { id: createdId, importance: 1.0, pinned: true },
        });
        const payload = parsePayload<{
          ok: boolean;
          memory: { importance: number; pinned: boolean };
        }>(raw);
        if (!payload.ok) throw new Error("update did not ok");
        if (payload.memory.importance !== 1.0) throw new Error("importance not updated");
        if (!payload.memory.pinned) throw new Error("pinned not set");
      },
    },
    {
      name: "memory_list_recent includes the entry",
      async run() {
        const raw = await client.callTool({
          name: "memory_list_recent",
          arguments: { k: 20 },
        });
        const payload = parsePayload<{
          total: number;
          memories: Array<{ id: string }>;
        }>(raw);
        if (!payload.memories.some((m) => m.id === createdId)) {
          throw new Error("entry not in recent list");
        }
      },
    },
    {
      name: "memory_stats returns counters",
      async run() {
        const raw = await client.callTool({
          name: "memory_stats",
          arguments: {},
        });
        const payload = parsePayload<{ total: number; byType: Record<string, number> }>(
          raw,
        );
        if (typeof payload.total !== "number") throw new Error("no total");
        log(
          `total=${payload.total} byType=${JSON.stringify(payload.byType)}`,
        );
      },
    },
    {
      name: "memory_remove deletes the entry",
      async run() {
        if (!createdId) throw new Error("no id");
        const raw = await client.callTool({
          name: "memory_remove",
          arguments: { id: createdId },
        });
        const payload = parsePayload<{ ok: boolean; deleted: string }>(raw);
        if (!payload.ok || payload.deleted !== createdId) {
          throw new Error("remove did not confirm");
        }
      },
    },
  ];

  for (const step of steps) {
    try {
      await step.run();
      ok(step.name);
    } catch (err) {
      fail(step.name, err);
    }
  }

  await client.close();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
