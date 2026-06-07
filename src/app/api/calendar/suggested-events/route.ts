/**
 * Suggested calendar events (from transcriptions) — approval queue listing.
 */
import { NextRequest, NextResponse } from "next/server";
import { listSuggestedEvents } from "@/lib/calendar-db";
import { getTranscription } from "@/lib/transcriptions-db";
import type { SuggestedEventStatus } from "@/lib/calendar-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = (searchParams.get("status") as SuggestedEventStatus | null) ?? "pending";
  const transcriptionId = searchParams.get("transcription") || undefined;

  const items = listSuggestedEvents({ status, transcriptionId });
  const enriched = items.map((item) => {
    const t = getTranscription(item.transcription_id);
    return { ...item, transcription_title: t?.title ?? null };
  });
  return NextResponse.json({ items: enriched });
}
