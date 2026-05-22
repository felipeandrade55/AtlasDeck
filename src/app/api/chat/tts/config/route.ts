/**
 * GET   /api/chat/tts/config -> diagnostic info on how the runtime
 *                              resolves ElevenLabs configuration.
 * PATCH /api/chat/tts/config -> persists API key / voice id / model id
 *                              into memory_settings (so the user can
 *                              configure it from the chat UI without
 *                              touching env or openclaw.json).
 *
 * Neither route ever returns the full API key — only short head/tail
 * previews — to keep the diagnostic safe to surface from the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { elevenLabsDiagnostic } from "@/lib/elevenlabs";
import { setSettings } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(elevenLabsDiagnostic());
}

interface PatchBody {
  apiKey?: string | null;
  voiceId?: string | null;
  modelId?: string | null;
}

export async function PATCH(req: NextRequest) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, string | null> = {};
  if (body.apiKey !== undefined) {
    const v = body.apiKey?.trim();
    patch.elevenlabs_api_key = v && v.length > 0 ? v : null;
  }
  if (body.voiceId !== undefined) {
    const v = body.voiceId?.trim();
    patch.elevenlabs_voice_id = v && v.length > 0 ? v : null;
  }
  if (body.modelId !== undefined) {
    const v = body.modelId?.trim();
    patch.elevenlabs_model_id = v && v.length > 0 ? v : "eleven_multilingual_v2";
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Empty patch" }, { status: 400 });
  }

  setSettings(patch);
  return NextResponse.json(elevenLabsDiagnostic());
}
