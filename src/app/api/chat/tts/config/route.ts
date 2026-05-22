/**
 * GET   /api/chat/tts/config -> aggregate diagnostic for both TTS
 *                              providers (ElevenLabs + Fish Audio) plus
 *                              the user's preferred provider.
 * PATCH /api/chat/tts/config -> persists API keys / voice ids / models
 *                              for either provider, and the active
 *                              `provider` toggle, into memory_settings.
 *
 * Keys are never echoed back — diagnostic only exposes booleans and
 * short head/tail previews.
 */
import { NextRequest, NextResponse } from "next/server";
import { elevenLabsDiagnostic } from "@/lib/elevenlabs";
import { fishAudioDiagnostic } from "@/lib/fishaudio";
import { getSettings, setSettings, type TtsProvider } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildDiagnostic() {
  let preferred: TtsProvider = "elevenlabs";
  try {
    preferred = getSettings().tts_provider;
  } catch {
    // ignore
  }
  return {
    provider: preferred,
    elevenlabs: elevenLabsDiagnostic(),
    fishaudio: fishAudioDiagnostic(),
  };
}

export async function GET() {
  return NextResponse.json(buildDiagnostic());
}

interface PatchBody {
  provider?: TtsProvider;
  // ElevenLabs fields (legacy names kept so existing UI clients keep working)
  apiKey?: string | null;
  voiceId?: string | null;
  modelId?: string | null;
  elevenlabs?: {
    apiKey?: string | null;
    voiceId?: string | null;
    modelId?: string | null;
  };
  fishaudio?: {
    apiKey?: string | null;
    voiceId?: string | null;
    model?: string | null;
  };
}

export async function PATCH(req: NextRequest) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, string | null> = {};

  if (body.provider === "elevenlabs" || body.provider === "fishaudio") {
    patch.tts_provider = body.provider;
  }

  const eleven = body.elevenlabs ?? {
    apiKey: body.apiKey,
    voiceId: body.voiceId,
    modelId: body.modelId,
  };
  if (eleven.apiKey !== undefined) {
    const v = eleven.apiKey?.trim();
    patch.elevenlabs_api_key = v && v.length > 0 ? v : null;
  }
  if (eleven.voiceId !== undefined) {
    const v = eleven.voiceId?.trim();
    patch.elevenlabs_voice_id = v && v.length > 0 ? v : null;
  }
  if (eleven.modelId !== undefined) {
    const v = eleven.modelId?.trim();
    patch.elevenlabs_model_id = v && v.length > 0 ? v : "eleven_multilingual_v2";
  }

  if (body.fishaudio) {
    if (body.fishaudio.apiKey !== undefined) {
      const v = body.fishaudio.apiKey?.trim();
      patch.fishaudio_api_key = v && v.length > 0 ? v : null;
    }
    if (body.fishaudio.voiceId !== undefined) {
      const v = body.fishaudio.voiceId?.trim();
      patch.fishaudio_voice_id = v && v.length > 0 ? v : null;
    }
    if (body.fishaudio.model !== undefined) {
      const v = body.fishaudio.model?.trim();
      patch.fishaudio_model = v && v.length > 0 ? v : "s2-pro";
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Empty patch" }, { status: 400 });
  }

  setSettings(patch);
  return NextResponse.json(buildDiagnostic());
}
