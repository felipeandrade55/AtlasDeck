import { NextRequest, NextResponse } from "next/server";
import { getTaskById, updateTask } from "@/lib/tasks-db";
import { sendMail } from "@/lib/mailbox-db";
import { logActivity } from "@/lib/activities-db";
import { ingestTaskFeedbackById } from "@/lib/preference-model";
import { runDispatcher } from "@/lib/task-dispatcher";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * User-facing thumbs up/down on a task in "review" status. This is the
 * signal the preference model feeds on — both the explicit boolean and the
 * optional free-text feedback are persisted for later mining.
 *
 *   approved=true  → status moves to "done"
 *   approved=false → status moves back to "assigned" with feedback wired
 *                    into the specialist's mailbox
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json();
    if (typeof body?.approved !== "boolean") {
      return NextResponse.json({ error: "approved (boolean) is required" }, { status: 400 });
    }

    const feedback = typeof body.feedback === "string" ? body.feedback : null;

    const updated = updateTask(id, {
      user_approved: body.approved,
      user_feedback: feedback,
      status: body.approved ? "done" : "assigned",
    });

    if (!body.approved && task.assigned_to) {
      sendMail({
        task_id: id,
        from_agent_id: null, // human user
        to_agent_id: task.assigned_to,
        subject: "Usuário rejeitou — ajustar",
        body: feedback || "O usuário rejeitou esta entrega. Refaça levando em conta o histórico do task.",
        message_type: "review_feedback",
      });
    }

    logActivity(
      "task",
      `Usuário ${body.approved ? "👍 aprovou" : "👎 rejeitou"}: ${task.title || id}`,
      "success",
      { agent: task.assigned_to ?? undefined, metadata: { task_id: id, feedback: !!feedback } },
    );

    // Feed the preference model — explicit thumbs + (when present) feedback
    // text. Idempotent, so safe to call even if the user later edits the
    // feedback and re-submits.
    const learning = ingestTaskFeedbackById(id);

    // Approval flips status to "done" — that may unblock downstream subtasks
    // depending on it; rejection bumps the task back to "assigned" — the
    // specialist needs to pick it up again. Either way we want the
    // dispatcher to look at the queue right now instead of waiting for cron.
    try {
      runDispatcher();
    } catch (e) {
      console.warn("[approve] dispatcher kick failed:", e);
    }

    return NextResponse.json({ task: updated, learning });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
