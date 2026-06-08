import { NextResponse } from "next/server";
import { updateNote, deleteNote } from "@/lib/notes-db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    const note = updateNote(id, {
      title: body.title,
      content: body.content,
      color: body.color,
      pinned: body.pinned,
    });

    if (!note) {
      return NextResponse.json({ ok: false, error: "Note not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, note });
  } catch (error: any) {
    console.error("Failed to update note:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = deleteNote(id);

    if (!ok) {
      return NextResponse.json({ ok: false, error: "Note not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Failed to delete note:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
