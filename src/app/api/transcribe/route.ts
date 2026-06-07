/**
 * Transcription sessions — create + list.
 */
import { NextRequest, NextResponse } from "next/server";
import { createTranscription, listTranscriptions } from "@/lib/transcriptions-db";
import { isTranscribeConfigured } from "@/lib/openai-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = listTranscriptions();
    return NextResponse.json({
      configured: isTranscribeConfigured(),
      items,
    });
  } catch (err) {
    console.error("[/api/transcribe] list failed:", err);
    return NextResponse.json({ error: "Falha ao listar transcrições" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isTranscribeConfigured()) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY não configurada no servidor" },
        { status: 400 }
      );
    }
    const body = await request.json().catch(() => ({}));
    const t = createTranscription({ title: body.title, language: body.language });
    return NextResponse.json(t, { status: 201 });
  } catch (err) {
    console.error("[/api/transcribe] create failed:", err);
    return NextResponse.json({ error: "Falha ao criar transcrição" }, { status: 500 });
  }
}
