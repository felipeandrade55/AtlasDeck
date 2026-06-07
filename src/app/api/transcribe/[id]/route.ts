/**
 * Single transcription — detail (with suggested events) + delete.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTranscription, deleteTranscription } from "@/lib/transcriptions-db";
import { listSuggestedEvents } from "@/lib/calendar-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const suggestions = listSuggestedEvents({ transcriptionId: id });
  return NextResponse.json({ ...t, suggestions });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  deleteTranscription(id);
  try {
    logActivity("config", `Transcrição removida: ${t.title}`, "success", {
      metadata: { source: "transcription", transcription_id: id },
    });
  } catch {}
  return NextResponse.json({ success: true, deleted: id });
}
