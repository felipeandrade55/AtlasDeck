import { NextResponse } from "next/server";
import { getOllamaStatus, RECOMMENDED_MODELS } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getOllamaStatus();
  return NextResponse.json({
    ...status,
    recommended: RECOMMENDED_MODELS,
  });
}
