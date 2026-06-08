import { NextRequest, NextResponse } from "next/server";
import { listMemories, getAllLinks, type MemoryRow } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whole-graph payload for the Obsidian-style memory graph.
 *
 * Returns { nodes, links } in one shot. `source`/`target` keys match the
 * vocabulary the client-side force-graph engine consumes directly.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get("workspace") || undefined;

  // Load ALL non-archived memories. listMemories caps `limit` at 200, so we
  // page internally until we've covered `total` (non-invasive, no signature
  // change). A single-user instance has at most a few thousand memories.
  const all: MemoryRow[] = [];
  let offset = 0;
  for (;;) {
    const { memories, total } = listMemories({
      workspace,
      archived: false,
      limit: 200,
      offset,
      sort: "created",
    });
    all.push(...memories);
    offset += memories.length;
    if (memories.length === 0 || all.length >= total) break;
  }

  const idSet = new Set(all.map((m) => m.id));

  // Keep only edges whose both endpoints are present in the loaded node set.
  const links = getAllLinks()
    .filter((l) => idSet.has(l.from_id) && idSet.has(l.to_id))
    .map((l) => ({
      source: l.from_id,
      target: l.to_id,
      kind: l.kind,
      weight: l.weight,
    }));

  // Degree = number of connections, used to size nodes.
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const nodes = all.map((m) => ({
    id: m.id,
    label: m.title,
    type: m.type,
    importance: m.importance,
    degree: degree.get(m.id) ?? 0,
    tags: m.tags,
    pinned: m.pinned,
  }));

  return NextResponse.json({ nodes, links });
}
