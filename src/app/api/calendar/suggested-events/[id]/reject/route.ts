/**
 * Reject a suggested event → mark rejected. Nothing is created.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSuggestedEventById, updateSuggestedEvent } from "@/lib/calendar-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = getSuggestedEventById(id);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status !== "pending") {
    return NextResponse.json({ error: "Sugestão já resolvida" }, { status: 409 });
  }
  updateSuggestedEvent(id, { status: "rejected" });
  try {
    logActivity("calendar", `Sugestão de compromisso rejeitada: ${item.title}`, "success", {
      metadata: { source: "transcription", suggested_id: id },
    });
  } catch {}
  return NextResponse.json({ success: true });
}
