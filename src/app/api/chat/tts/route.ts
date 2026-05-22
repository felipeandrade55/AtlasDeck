/**
 * POST /api/chat/tts  -> stream ElevenLabs MP3 audio for the given text
 * GET  /api/chat/tts  -> ElevenLabs configuration status (without exposing the key)
 *
 * The browser hits this endpoint when TTS is enabled and ElevenLabs is
 * configured; the response body is `audio/mpeg` streamed straight from
 * ElevenLabs, so playback starts within ~500ms of the request.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  elevenLabsStatus,
  readElevenLabsConfig,
  streamElevenLabsTts,
} from "@/lib/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(elevenLabsStatus());
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

  const config = readElevenLabsConfig();
  if (!config) {
    return NextResponse.json(
      {
        error:
          "ElevenLabs nao configurado. Defina ELEVENLABS_API_KEY+ELEVENLABS_VOICE_ID no env, ou configure em /settings.",
      },
      { status: 503 },
    );
  }

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await streamElevenLabsTts(config, text, { signal: ac.signal });
  } catch (err) {
    return NextResponse.json(
      { error: `ElevenLabs request failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: `ElevenLabs returned HTTP ${upstream.status}: ${errText.slice(0, 240)}`,
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "x-tts-voice": config.voiceId,
      "x-tts-source": config.source,
    },
  });
}
