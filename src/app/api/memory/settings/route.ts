import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings, type MemorySettings } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Partial<MemorySettings> = {};

  if (typeof body.embedding_provider === "string") {
    patch.embedding_provider = body.embedding_provider;
  }
  if (typeof body.embedding_model === "string") {
    patch.embedding_model = body.embedding_model;
  }
  if (typeof body.forgetting_threshold === "number") {
    patch.forgetting_threshold = Math.max(0, Math.min(1, body.forgetting_threshold));
  }
  if (typeof body.forgetting_age_days === "number") {
    patch.forgetting_age_days = Math.max(1, Math.floor(body.forgetting_age_days));
  }
  if (typeof body.inject_into_memory_md === "boolean") {
    patch.inject_into_memory_md = body.inject_into_memory_md;
  }
  if (typeof body.extraction_enabled === "boolean") {
    patch.extraction_enabled = body.extraction_enabled;
  }
  if (
    body.extractor_provider === "openclaw" ||
    body.extractor_provider === "ollama" ||
    body.extractor_provider === "heuristic"
  ) {
    patch.extractor_provider = body.extractor_provider;
  }
  if (typeof body.ollama_model === "string" && body.ollama_model.trim()) {
    patch.ollama_model = body.ollama_model.trim();
  }

  return NextResponse.json(setSettings(patch));
}
