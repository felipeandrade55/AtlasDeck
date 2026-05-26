import { NextRequest, NextResponse } from "next/server";
import { getTaskById, updateTask, type ReviewVerdict } from "@/lib/tasks-db";
import { sendMail } from "@/lib/mailbox-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_VERDICTS: ReviewVerdict[] = ["approved", "rejected", "needs_revision"];

/**
 * Orchestrator review verdict. After the sub-agent signals complete, the
 * orchestrator (or the user, if there's no delegated_by) evaluates the
 * result and posts here:
 *
 *   approved        → task moves toward "done" (still pending user approval
 *                     unless autonomous_mode bypasses)
 *   rejected        → task goes back to "assigned" with notes; specialist
 *                     receives review_feedback mail and retries
 *   needs_revision  → same as rejected but softer, kept separate so the
 *                     learner can distinguish "wrong direction" from
 *                     "right direction needs polish"
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json();
    const verdict = body?.verdict as ReviewVerdict | undefined;
    if (!verdict || !VALID_VERDICTS.includes(verdict)) {
      return NextResponse.json(
        { error: `verdict must be one of: ${VALID_VERDICTS.join(", ")}` },
        { status: 400 },
      );
    }

    const notes = typeof body.notes === "string" ? body.notes : null;
    const reviewerId = body.reviewer_id || task.delegated_by || null;

    let nextStatus: typeof task.status;
    if (verdict === "approved") {
      // Stay in "review" if the user has yet to give 👍/👎, unless autonomous
      // mode is enabled (the orchestrator will hit /approve programmatically
      // in that flow).
      nextStatus = "review";
    } else {
      // Bounce back for another pass.
      nextStatus = "assigned";
    }

    const updated = updateTask(id, {
      status: nextStatus,
      review_verdict: verdict,
      review_notes: notes,
    });

    if (verdict !== "approved" && task.assigned_to) {
      sendMail({
        task_id: id,
        from_agent_id: reviewerId,
        to_agent_id: task.assigned_to,
        subject: verdict === "rejected" ? "Review: rejeitado" : "Review: precisa revisão",
        body:
          notes ||
          (verdict === "rejected"
            ? "Resultado rejeitado. Recomece levando em conta o contexto."
            : "Resultado precisa de revisão. Ajuste os pontos solicitados."),
        message_type: "review_feedback",
      });
    }

    logActivity("task", `Review ${verdict}: ${task.title || id}`, "success", {
      agent: reviewerId ?? undefined,
      metadata: { task_id: id, verdict, has_notes: !!notes },
    });

    return NextResponse.json({ task: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
