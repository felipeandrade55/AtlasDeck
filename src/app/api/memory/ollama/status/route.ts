import { NextResponse } from "next/server";
import {
  getOllamaStatus,
  getServiceState,
  RECOMMENDED_MODELS,
} from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [status, service] = await Promise.all([
    getOllamaStatus(),
    getServiceState(),
  ]);
  return NextResponse.json({
    ...status,
    recommended: RECOMMENDED_MODELS,
    service,
  });
}
