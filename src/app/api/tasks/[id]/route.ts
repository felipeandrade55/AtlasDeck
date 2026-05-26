import { NextRequest, NextResponse } from "next/server";
import {
  getTaskById,
  updateTask,
  deleteTask,
  listChildren,
  listCheckpoints,
} from "@/lib/tasks-db";
import { listMail } from "@/lib/mailbox-db";
import { discardTaskWorkspace } from "@/lib/task-workspace";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    return NextResponse.json({
      task,
      children: listChildren(id),
      checkpoints: listCheckpoints(id, 20),
      messages: listMail({ task_id: id, sort: "oldest", limit: 200 }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const updated = updateTask(id, {
      status: body.status,
      assigned_to: body.assigned_to,
      title: body.title,
      result: body.result,
      review_verdict: body.review_verdict,
      review_notes: body.review_notes,
      user_approved: body.user_approved,
      user_feedback: body.user_feedback,
      cost_cents: body.cost_cents,
      tokens_in: body.tokens_in,
      tokens_out: body.tokens_out,
      metadata: body.metadata,
    });
    if (!updated) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const existed = !!getTaskById(id);
    if (!existed) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    // Reclaim disk: drop the isolated workspace if it was allocated.
    discardTaskWorkspace(id);
    deleteTask(id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
