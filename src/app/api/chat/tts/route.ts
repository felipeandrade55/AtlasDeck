/**
 * POST /api/chat/tts -> stream MP3 audio for the given text, from
 *                      whichever TTS provider the user selected in
 *                      settings (`tts_provider`: "elevenlabs" or
 *                      "fishaudio"). The selected provider is strict:
 *                      Fish Audio never falls back to ElevenLabs and
 *                      ElevenLabs never falls back to Fish Audio.
 * GET  /api/chat/tts -> active provider status (provider name, voice
 *                      id, configured flag) without exposing keys.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  elevenLabsStatus,
  readElevenLabsConfig,
  streamElevenLabsTts,
} from "@/lib/elevenlabs";
import {
  fishAudioStatus,
  readFishAudioConfig,
  streamFishAudioTts,
} from "@/lib/fishaudio";
import { getSettings, type TtsProvider } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActiveTtsStatus {
  provider: TtsProvider | null;
  configured: boolean;
  voiceId: string | null;
  source: string | null;
  elevenlabs: ReturnType<typeof elevenLabsStatus>;
  fishaudio: ReturnType<typeof fishAudioStatus>;
  /** What the user picked, even if it isn't currently usable. */
  preferred: TtsProvider;
}

function resolveActive(): ActiveTtsStatus {
  const eleven = elevenLabsStatus();
  const fish = fishAudioStatus();
  let preferred: TtsProvider = "elevenlabs";
  try {
    preferred = getSettings().tts_provider;
  } catch {
    // ignore — fall back to default
  }

  const selectedStatus = preferred === "elevenlabs" ? eleven : fish;
  if (selectedStatus.configured) {
    return {
      provider: preferred,
      configured: true,
      voiceId: selectedStatus.voiceId,
      source: selectedStatus.source,
      elevenlabs: eleven,
      fishaudio: fish,
      preferred,
    };
  }

  return {
    provider: null,
    configured: false,
    voiceId: null,
    source: null,
    elevenlabs: eleven,
    fishaudio: fish,
    preferred,
  };
}

export async function GET() {
  return NextResponse.json(resolveActive());
}

interface TtsBody {
  text?: string;
}

export async function POST(req: NextRequest) {
  let body: TtsBody;
  try {
    body = (await req.json()) as TtsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Missing 'text'" }, { status: 400 });
  }
  if (text.length > 5000) {
    return NextResponse.json(
      { error: "Text exceeds 5000 chars; chunk before requesting" },
      { status: 400 },
    );
  }

  const active = resolveActive();
  if (!active.provider) {
    return NextResponse.json(
      {
        error: `${active.preferred} selecionado, mas nao configurado. Configure este provider em Voz do Jarvis.`,
      },
      { status: 503 },
    );
  }

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });

  let upstream: Response;
  let voiceHeader: string;
  let sourceHeader: string;
  try {
    if (active.provider === "elevenlabs") {
      const config = readElevenLabsConfig();
      if (!config) throw new Error("ElevenLabs config disappeared");
      upstream = await streamElevenLabsTts(config, text, { signal: ac.signal });
      voiceHeader = config.voiceId;
      sourceHeader = config.source;
    } else {
      const config = readFishAudioConfig();
      if (!config) throw new Error("FishAudio config disappeared");
      upstream = await streamFishAudioTts(config, text, { signal: ac.signal });
      voiceHeader = config.voiceId ?? "default";
      sourceHeader = config.source;
    }
  } catch (err) {
    return NextResponse.json(
      { error: `${active.provider} request failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: `${active.provider} returned HTTP ${upstream.status}: ${errText.slice(0, 240)}`,
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "x-tts-provider": active.provider,
      "x-tts-voice": voiceHeader,
      "x-tts-source": sourceHeader,
    },
  });
}
