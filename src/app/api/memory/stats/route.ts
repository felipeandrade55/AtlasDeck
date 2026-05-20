import { NextResponse } from "next/server";
import { getStats } from "@/lib/memory-db";
import { getIndexStats } from "@/lib/memory-fts";
import { isEmbeddingReady } from "@/lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stats = getStats();
  const fts = getIndexStats();
  const ready = await isEmbeddingReady();
  return NextResponse.json({ ...stats, fts, embeddingReady: ready });
}
