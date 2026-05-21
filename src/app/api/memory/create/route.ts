import { NextRequest, NextResponse } from "next/server";
import {
  upsertMemory,
  setMemoryEmbedding,
  searchSimilar,
  createLink,
  type MemoryType,
} from "@/lib/memory-db";
import { embedTexts } from "@/lib/embeddings";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<MemoryType>([
  "episodic",
  "semantic",
  "procedural",
  "identity",
]);

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspace = typeof body.workspace === "string" ? body.workspace : "";
  const type = body.type as MemoryType;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const summary = typeof body.summary === "string" ? body.summary : undefined;
  const tags = Array.isArray(body.tags)
    ? (body.tags as unknown[]).map(String)
    : undefined;
  const importance =
    typeof body.importance === "number"
      ? Math.min(1, Math.max(0, body.importance))
      : 0.6;
  const pinned = Boolean(body.pinned);
  const language = typeof body.language === "string" ? body.language : undefined;

  if (!workspace) {
    return NextResponse.json({ error: "Missing workspace" }, { status: 400 });
  }
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
  if (!title || !content) {
    return NextResponse.json(
      { error: "Missing title or content" },
      { status: 400 },
    );
  }

  try {
    const memory = upsertMemory({
      workspace,
      type,
      title,
      content,
      summary,
      source: "manual",
      tags,
      importance,
      pinned,
      language,
    });

    // Best-effort embedding so manual entries also participate in semantic search
    let embedded = false;
    try {
      const { vectors, provider } = await embedTexts([`${title}\n${content}`]);
      setMemoryEmbedding(
        memory.id,
        vectors[0],
        `${provider.id}:${provider.modelId}`,
        provider.dim,
      );
      embedded = true;

      const similar = searchSimilar(vectors[0], {
        workspace,
        excludeIds: [memory.id],
        k: 5,
        minScore: 0.85,
      });
      for (const hit of similar) {
        createLink(memory.id, hit.memory.id, "related", "cosine", hit.score);
      }
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory/create] embedding failed:", err);
      }
    }

    try {
      logActivity("memory", `Memória criada: ${memory.title} (${memory.type})`, "success", {
        agent: "manual",
        metadata: { memoryId: memory.id, type: memory.type, embedded, workspace },
      });
    } catch {}

    return NextResponse.json({ memory, embedded });
  } catch (err) {
    console.error("[memory/create] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Create failed" },
      { status: 500 },
    );
  }
}
