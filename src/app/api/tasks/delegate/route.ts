import { NextRequest, NextResponse } from "next/server";
import { createTask, updateTask } from "@/lib/tasks-db";
import { ensureTaskWorkspace } from "@/lib/task-workspace";
import { sendMail } from "@/lib/mailbox-db";
import { logActivity } from "@/lib/activities-db";
import { runDispatcher } from "@/lib/task-dispatcher";

export const dynamic = "force-dynamic";

/**
 * Delegation endpoint — same as POST /api/tasks but with a clearer name,
 * automatic "inbox" status, and a heads-up note dropped into the assignee's
 * mailbox so checkpoint-aware agents can pick it up.
 *
 * Body shape:
 *   {
 *     assigned_to: "dev",          // required
 *     prompt: "implementa X",       // required
 *     title?: "Implementa X",
 *     delegated_by?: "main",
 *     parent_task_id?: string,
 *     depends_on?: string[],
 *     metadata?: object
 *   }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body?.assigned_to || typeof body.assigned_to !== "string") {
      return NextResponse.json({ error: "assigned_to is required" }, { status: 400 });
    }
    if (!body?.prompt || typeof body.prompt !== "string") {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // Origin channel is "where did the human ask for this from" — chat web,
    // Telegram, voice, etc. Persisted in metadata so notify_user can route
    // the reply back to the same place without bouncing through every
    // surface.
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
      assigned_to: body.assigned_to,
      status: "inbox",
      title: body.title || body.prompt.slice(0, 80),
      prompt: body.prompt,
      depends_on: Array.isArray(body.depends_on) ? body.depends_on : [],
      metadata,
    });

    const ws = ensureTaskWorkspace(task.id);
    const updated = updateTask(task.id, { workspace_path: ws.relativePath });

    // Drop a heads-up note in the assignee's mailbox so polling agents
    // notice the new delegation at their next checkpoint.
    sendMail({
      task_id: task.id,
      from_agent_id: body.delegated_by ?? null,
      to_agent_id: body.assigned_to,
      subject: "Nova tarefa delegada",
      body: task.title || task.prompt.slice(0, 200),
      message_type: "inter_agent",
    });

    logActivity("task", `Delegação: ${body.delegated_by || "user"} → ${body.assigned_to}`, "success", {
      agent: body.assigned_to,
      metadata: { task_id: task.id, parent: body.parent_task_id ?? null },
    });

    // Try to move the task forward immediately if its deps are already done
    // and the agent is under cap. Cheap (single SELECT) and gives the UI an
    // instant transition `inbox → assigned`.
    let dispatched = 0;
    try {
      const result = runDispatcher();
      dispatched = result.dispatched;
    } catch (e) {
      console.warn("[delegate] dispatcher kick failed:", e);
    }

    return NextResponse.json({ task: updated ?? task, dispatched });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
