import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  listTasks,
  getTaskStats,
  type TaskStatus,
  TASK_STATUSES,
} from "@/lib/tasks-db";
import { ensureTaskWorkspace } from "@/lib/task-workspace";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const statusParam = searchParams.get("status");
    const parentParam = searchParams.get("parent_task_id");

    let statusFilter: TaskStatus | TaskStatus[] | undefined;
    if (statusParam && statusParam !== "all") {
      const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
      const valid = parts.filter((p): p is TaskStatus => (TASK_STATUSES as string[]).includes(p));
      if (valid.length > 0) statusFilter = valid.length === 1 ? valid[0] : valid;
    }

    const tasks = listTasks({
      status: statusFilter,
      assigned_to: searchParams.get("assigned_to") || undefined,
      delegated_by: searchParams.get("delegated_by") || undefined,
      parent_task_id:
        parentParam === "null"
          ? null
          : parentParam === null
            ? undefined
            : parentParam,
      limit: Number(searchParams.get("limit") || 100),
      offset: Number(searchParams.get("offset") || 0),
      sort: (searchParams.get("sort") as "newest" | "oldest") || "newest",
    });

    const includeStats = searchParams.get("stats") === "1";
    return NextResponse.json({
      tasks,
      total: tasks.length,
      stats: includeStats ? getTaskStats() : undefined,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.prompt || typeof body.prompt !== "string") {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const origin_channel =
      typeof body.origin_channel === "string" && body.origin_channel
        ? body.origin_channel
        : "chat";
    const metadata = {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      origin_channel,
    };

    const task = createTask({
      parent_task_id: body.parent_task_id ?? null,
      delegated_by: body.delegated_by ?? null,
      assigned_to: body.assigned_to ?? null,
      status: body.status ?? "inbox",
      title: body.title || body.prompt.slice(0, 80),
      prompt: body.prompt,
      depends_on: Array.isArray(body.depends_on) ? body.depends_on : [],
      metadata,
    });

    // Always allocate an isolated workspace so the assignee can write
    // without colliding with peers running concurrent siblings.
    const ws = ensureTaskWorkspace(task.id);
    const { updateTask } = await import("@/lib/tasks-db");
    const updated = updateTask(task.id, { workspace_path: ws.relativePath });

    logActivity("task", `Task criada: ${task.title || task.id}`, "success", {
      agent: task.assigned_to ?? undefined,
      metadata: { task_id: task.id, status: task.status, delegated_by: task.delegated_by },
    });

    return NextResponse.json({ task: updated ?? task });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
