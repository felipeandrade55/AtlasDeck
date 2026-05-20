import { NextRequest, NextResponse } from "next/server";
import { getMemoryById, updateMemory } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // body is optional
  }
  const archived = body.archived === undefined ? true : Boolean(body.archived);
  const memory = getMemoryById(id);
  if (!memory) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = updateMemory(id, { archived });
  return NextResponse.json({ memory: updated });
}
