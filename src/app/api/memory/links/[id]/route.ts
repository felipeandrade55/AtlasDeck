import { NextRequest, NextResponse } from "next/server";
import { getLinksFor, getMemoryById } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getMemoryById(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const links = getLinksFor(id);
  const related = links
    .map((l) => {
      const otherId = l.from_id === id ? l.to_id : l.from_id;
      const memory = getMemoryById(otherId);
      return memory
        ? {
            link: l,
            memory: {
              id: memory.id,
              title: memory.title,
              summary: memory.summary,
              type: memory.type,
              importance: memory.importance,
            },
          }
        : null;
    })
    .filter((x) => x !== null);
  return NextResponse.json({ links: related });
}
