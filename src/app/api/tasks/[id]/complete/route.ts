import { NextRequest, NextResponse } from "next/server";
import { getTaskById, updateTask, addTaskUsage } from "@/lib/tasks-db";
import { sendMail } from "@/lib/mailbox-db";
import { recordHeartbeat } from "@/lib/agent-health";
import { logActivity } from "@/lib/activities-db";
import { runDispatcher } from "@/lib/task-dispatcher";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Sub-agent signals it finished the task. We move it to "review" and ping
 * the orchestrator's mailbox so it can pick the result up for evaluation.
 * If the task has no `delegated_by`, the user is the implicit reviewer —
 * we still move to "review" but skip the mailbox notification.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));

    if (body.cost_cents || body.tokens_in || body.tokens_out) {
      addTaskUsage(id, {
        cost_cents: body.cost_cents,
        tokens_in: body.tokens_in,
        tokens_out: body.tokens_out,
      });
    }

    const updated = updateTask(id, {
      status: "review",
      result: typeof body.result === "string" ? body.result : task.result,
    });

    if (task.assigned_to) {
      recordHeartbeat({
        agent_id: task.assigned_to,
        current_task_id: null,
        state: "idle",
      });
    }

    if (task.delegated_by) {
      sendMail({
        task_id: id,
        from_agent_id: task.assigned_to,
        to_agent_id: task.delegated_by,
        subject: `Task pronta para review: ${task.title || id}`,
        body:
          typeof body.result === "string"
            ? body.result.slice(0, 2000)
            : "Sub-agente sinalizou conclusão. Avalie e dê verdict.",
        message_type: "inter_agent",
      });
    }

    logActivity("task", `Task completa (review): ${task.title || id}`, "success", {
      agent: task.assigned_to ?? undefined,
      metadata: { task_id: id, delegated_by: task.delegated_by },
    });

    // Completing a task may unblock downstream subtasks in a DAG — kick
    // the dispatcher so it picks them up immediately.
    try {
      runDispatcher();
    } catch (e) {
      console.warn("[complete] dispatcher kick failed:", e);
    }

    return NextResponse.json({ task: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
