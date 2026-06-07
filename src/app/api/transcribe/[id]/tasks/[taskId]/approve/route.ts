/**
 * Approve a suggested task (action item) → create a reminder on the dashboard,
 * mark the suggestion approved. Accepts optional overrides for task text, due
 * date and owner (the UI prefills from the suggestion and lets the user adjust).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSuggestedTaskById,
  updateSuggestedTask,
  createReminder,
} from "@/lib/reminders-db";
import { logActivity } from "@/lib/activities-db";
import { addNotification } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { taskId } = await params;
  const item = getSuggestedTaskById(taskId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status !== "pending") {
    return NextResponse.json({ error: "Sugestão já resolvida" }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const task = (typeof body.task === "string" && body.task.trim()) || item.task;
  const owner = body.owner !== undefined ? body.owner : item.owner;
  const dueAt =
    typeof body.due_at === "string"
      ? body.due_at || null
      : item.due_date;

  const text = owner ? `${task} (${owner})` : task;

  try {
    const reminder = createReminder({ text, due_at: dueAt });
    updateSuggestedTask(taskId, { status: "approved", reminder_id: reminder.id });

    try {
      logActivity("agent", `Tarefa aprovada da transcrição: ${task}`, "success", {
        metadata: { source: "transcription", suggested_task_id: taskId, reminder_id: reminder.id },
      });
    } catch {}
    try {
      await addNotification(
        "✅ Tarefa criada",
        `"${task}" foi adicionada aos lembretes.`,
        "success",
        "/reminders",
        { source: "transcription", reminder_id: reminder.id }
      );
    } catch {}

    return NextResponse.json({ success: true, reminder });
  } catch (err) {
    console.error("[/api/transcribe/tasks/approve] failed:", err);
    return NextResponse.json({ error: "Falha ao criar lembrete" }, { status: 500 });
  }
}
