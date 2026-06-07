/**
 * Reject a suggested task (action item) — marks it rejected, no reminder created.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSuggestedTaskById, updateSuggestedTask } from "@/lib/reminders-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { taskId } = await params;
  const item = getSuggestedTaskById(taskId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status !== "pending") {
    return NextResponse.json({ error: "Sugestão já resolvida" }, { status: 409 });
  }
  updateSuggestedTask(taskId, { status: "rejected" });
  try {
    logActivity("agent", `Sugestão de tarefa rejeitada: ${item.task}`, "success", {
      metadata: { source: "transcription", suggested_task_id: taskId },
    });
  } catch {}
  return NextResponse.json({ success: true });
}
