import { NextResponse } from "next/server";
import { getQuickNote, upsertQuickNote } from "@/lib/notes-db";

export async function GET() {
  try {
    const note = getQuickNote();
    return NextResponse.json({ ok: true, note });
  } catch (error: any) {
    console.error("Failed to fetch quick note:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const content = typeof body.content === "string" ? body.content : "";
    const note = upsertQuickNote(content);
    return NextResponse.json({ ok: true, note });
  } catch (error: any) {
    console.error("Failed to save quick note:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
