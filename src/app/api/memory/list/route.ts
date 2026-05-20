import { NextRequest, NextResponse } from "next/server";
import { listMemories, type MemoryType } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "episodic",
  "semantic",
  "procedural",
  "identity",
]);
const VALID_SORTS: ReadonlySet<string> = new Set([
  "created",
  "updated",
  "importance",
  "accessed",
]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get("workspace") || undefined;
  const agent = searchParams.get("agent") || undefined;
  const typeParam = searchParams.get("type");
  const pinnedParam = searchParams.get("pinned");
  const archivedParam = searchParams.get("archived");
  const sort = searchParams.get("sort") || "created";
  const limit = Number.parseInt(searchParams.get("limit") || "25", 10);
  const offset = Number.parseInt(searchParams.get("offset") || "0", 10);
  const search = searchParams.get("q") || undefined;

  let type: MemoryType | MemoryType[] | undefined;
  if (typeParam) {
    const parts = typeParam.split(",").map((s) => s.trim()).filter(Boolean);
    const valid = parts.filter((p) => VALID_TYPES.has(p)) as MemoryType[];
    if (valid.length === 1) type = valid[0];
    else if (valid.length > 1) type = valid;
  }

  const result = listMemories({
    workspace,
    agent_id: agent,
    type,
    pinned:
      pinnedParam === "true" ? true : pinnedParam === "false" ? false : undefined,
    archived:
      archivedParam === "true"
        ? true
        : archivedParam === "false"
        ? false
        : false,
    search,
    sort: VALID_SORTS.has(sort) ? (sort as "created" | "updated" | "importance" | "accessed") : "created",
    limit,
    offset,
  });

  return NextResponse.json(result);
}
