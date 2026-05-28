import { NextResponse } from "next/server";
import { updateReminder, deleteReminder } from "@/lib/reminders-db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    const reminder = updateReminder(id, {
      text: body.text,
      completed: body.completed,
      due_at: body.due_at,
    });

    if (!reminder) {
      return NextResponse.json({ ok: false, error: "Reminder not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, reminder });
  } catch (error: any) {
    console.error("Failed to update reminder:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = deleteReminder(id);

    if (!ok) {
      return NextResponse.json({ ok: false, error: "Reminder not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Failed to delete reminder:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
