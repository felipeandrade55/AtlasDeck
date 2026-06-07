/**
 * Speech-to-text via the OpenAI audio transcriptions API.
 *
 * Used for chunked, near-real-time transcription of long meetings: each
 * audio chunk (webm/opus from the browser MediaRecorder) is posted here and
 * the text is appended to the growing transcript. Audio is NOT persisted —
 * the caller discards the buffer after we return the text.
 *
 * Model is configurable via TRANSCRIBE_MODEL (default "whisper-1"). Requires
 * OPENAI_API_KEY.
 */

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";

export function getTranscribeModel(): string {
  return process.env.TRANSCRIBE_MODEL?.trim() || "whisper-1";
}

export function isTranscribeConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export interface TranscribeResult {
  text: string;
  model: string;
}

export async function transcribeAudio(
  audio: Buffer,
  opts: { filename?: string; mimeType?: string; language?: string; signal?: AbortSignal } = {}
): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não configurada");
  }
  const model = getTranscribeModel();
  const filename = opts.filename || "chunk.webm";
  const mimeType = opts.mimeType || "audio/webm";

  // Node 18+ has global FormData/Blob/fetch.
  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio)], { type: mimeType });
  form.append("file", blob, filename);
  form.append("model", model);
  if (opts.language) form.append("language", opts.language);
  // Plain text response keeps parsing trivial and avoids verbose JSON.
  form.append("response_format", "text");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI transcription ${res.status}: ${detail.slice(0, 300)}`);
  }

  const text = (await res.text()).trim();
  return { text, model };
}
