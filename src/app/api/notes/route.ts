import { NextResponse } from "next/server";
import { createNote, listAllNotes } from "@/lib/notes-db";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search");
    const notes = listAllNotes(search);
    return NextResponse.json({ ok: true, notes });
  } catch (error: any) {
    console.error("Failed to fetch notes:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";

    if (!title && !content.trim()) {
      return NextResponse.json(
        { ok: false, error: "Title or content is required" },
        { status: 400 }
      );
    }

    const note = createNote({
      title,
      content,
      color: typeof body.color === "string" ? body.color : "default",
    });

    return NextResponse.json({ ok: true, note });
  } catch (error: any) {
    console.error("Failed to create note:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
