import { NextResponse } from "next/server";
import { createReminder, listAllReminders } from "@/lib/reminders-db";

export async function GET() {
  try {
    const reminders = listAllReminders();
    return NextResponse.json({ ok: true, reminders });
  } catch (error: any) {
    console.error("Failed to fetch reminders:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ ok: false, error: "Text is required" }, { status: 400 });
    }

    const reminder = createReminder({
      text: body.text.trim(),
      completed: !!body.completed,
      due_at: body.due_at || null,
    });

    return NextResponse.json({ ok: true, reminder });
  } catch (error: any) {
    console.error("Failed to create reminder:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
