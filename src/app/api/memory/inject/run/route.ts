/**
 * Manual injection trigger — regenerates AUTO_RECALL section in
 * each workspace's MEMORY.md.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  injectIntoWorkspace,
  injectAllWorkspaces,
} from "@/lib/memory-injector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // optional body
  }

  const workspace = typeof body.workspace === "string" ? body.workspace : null;
  const maxMemories = Math.min(
    Math.max(Number(body.maxMemories) || 20, 1),
    80,
  );

  try {
    if (workspace) {
      const result = await injectIntoWorkspace(workspace, { maxMemories });
      return NextResponse.json({ success: true, result });
    }
    const results = await injectAllWorkspaces({ maxMemories });
    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error("[memory/inject/run] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Injection failed" },
      { status: 500 },
    );
  }
}
