/**
 * GET /api/chat/search?q=...  -> FTS over message content
 */
import { NextRequest, NextResponse } from "next/server";
import { searchMessages } from "@/lib/chat-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Number(url.searchParams.get("limit") ?? "50");

  if (!q) {
    return NextResponse.json({ hits: [] });
  }
  const hits = searchMessages(q, Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ hits });
}
