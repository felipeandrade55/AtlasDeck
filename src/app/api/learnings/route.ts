import { NextRequest, NextResponse } from "next/server";
import {
  listLearnings,
  refuteLearning,
  deleteLearning,
} from "@/lib/learnings-db";
import { ingestTaskFeedbackById } from "@/lib/preference-model";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("count_only") === "1") {
    const all = listLearnings({ include_refuted: false });
    return NextResponse.json({ total_active: all.length });
  }

  const agentParam = searchParams.get("agent_id");
  const agent_id = agentParam === "null" ? null : agentParam ?? undefined;
  const learnings = listLearnings({
    agent_id,
    include_refuted: searchParams.get("include_refuted") === "1",
    min_confidence: searchParams.get("min_confidence")
      ? Number(searchParams.get("min_confidence"))
      : undefined,
    limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
  });
  return NextResponse.json({ learnings, total: learnings.length });
}

/**
 * POST is the "ingest feedback for this task" hook — UI calls it after a
 * thumbs-up/down to populate the preference model. Idempotent: re-ingesting
 * the same task only bumps confidence.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.task_id || typeof body.task_id !== "string") {
      return NextResponse.json({ error: "task_id is required" }, { status: 400 });
    }
    const result = ingestTaskFeedbackById(body.task_id);
    if (!result) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const refuted = refuteLearning(body.id);
    if (!refuted) return NextResponse.json({ error: "Learning not found" }, { status: 404 });
    return NextResponse.json({ learning: refuted });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
    const ok = deleteLearning(id);
    if (!ok) return NextResponse.json({ error: "Learning not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
