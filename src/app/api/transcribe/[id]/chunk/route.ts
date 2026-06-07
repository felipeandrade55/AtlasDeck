/**
 * Receives one audio chunk (FormData: audio Blob + seq), transcribes it via
 * OpenAI, appends the text to the session, and DISCARDS the audio. Returns
 * the chunk text so the UI can show the transcript growing live.
 */
import { NextRequest, NextResponse } from "next/server";
import { appendChunk, getTranscription } from "@/lib/transcriptions-db";
import { transcribeAudio } from "@/lib/openai-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "FormData inválido" }, { status: 400 });
  }

  const seqRaw = form.get("seq");
  const seq = Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0) {
    return NextResponse.json({ error: "seq inválido" }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "campo 'audio' ausente" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ seq, text: "" });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "audio/webm";
    const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
    const result = await transcribeAudio(buffer, {
      filename: `chunk-${seq}.${ext}`,
      mimeType,
      language: t.language || "pt",
      signal: request.signal,
    });
    // Audio buffer is dropped here — only the text is persisted.
    appendChunk(id, seq, result.text);
    return NextResponse.json({ seq, text: result.text });
  } catch (err) {
    console.error("[/api/transcribe/chunk] failed:", err);
    const msg = err instanceof Error ? err.message : "Falha ao transcrever";
    // 429 = quota exceeded / rate limit from OpenAI → surface as 402 so the UI
    // can show a friendly message instead of nginx turning it into a 502.
    const status = msg.includes("429") ? 402 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
