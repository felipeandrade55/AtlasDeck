/**
 * Fish Audio TTS integration — sibling of `elevenlabs.ts`.
 *
 * Configuration is resolved in priority order:
 *   1. Environment (FISHAUDIO_API_KEY, FISHAUDIO_VOICE_ID, FISHAUDIO_MODEL)
 *   2. AtlasDeck `memory_settings` (`fishaudio_*`) via the settings UI
 *
 * Voice id is optional: when only the API key is present we let Fish
 * Audio pick a default voice (any voice).
 *
 * POST https://api.fish.audio/v1/tts returns audio/mpeg with
 * Transfer-Encoding: chunked, which we forward straight to the browser.
 */
import { getSettings } from "@/lib/memory-db";

export interface FishAudioConfig {
  apiKey: string;
  voiceId: string | null;
  model: string;
  source: "env" | "memory_settings";
}

export interface FishAudioStatus {
  configured: boolean;
  hasVoiceId: boolean;
  voiceId: string | null;
  model: string | null;
  source: FishAudioConfig["source"] | null;
}

export interface FishAudioDiagnostic extends FishAudioStatus {
  envHasApiKey: boolean;
  envHasVoiceId: boolean;
  memorySettingsHasApiKey: boolean;
  memorySettingsHasVoiceId: boolean;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function readFromEnv(): FishAudioConfig | null {
  const apiKey = clean(process.env.FISHAUDIO_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: clean(process.env.FISHAUDIO_VOICE_ID),
    model: clean(process.env.FISHAUDIO_MODEL) ?? "s2-pro",
    source: "env",
  };
}

function readFromMemorySettings(): FishAudioConfig | null {
  try {
    const s = getSettings();
    if (!s.fishaudio_api_key) return null;
    return {
      apiKey: s.fishaudio_api_key,
      voiceId: s.fishaudio_voice_id,
      model: s.fishaudio_model || "s2-pro",
      source: "memory_settings",
    };
  } catch {
    return null;
  }
}

export function readFishAudioConfig(): FishAudioConfig | null {
  return readFromEnv() ?? readFromMemorySettings();
}

export function fishAudioStatus(): FishAudioStatus {
  const config = readFishAudioConfig();
  if (!config) {
    return {
      configured: false,
      hasVoiceId: false,
      voiceId: null,
      model: null,
      source: null,
    };
  }
  return {
    configured: true,
    hasVoiceId: !!config.voiceId,
    voiceId: config.voiceId,
    model: config.model,
    source: config.source,
  };
}

export function fishAudioDiagnostic(): FishAudioDiagnostic {
  const status = fishAudioStatus();
  const envHasApiKey = !!clean(process.env.FISHAUDIO_API_KEY);
  const envHasVoiceId = !!clean(process.env.FISHAUDIO_VOICE_ID);

  let memorySettingsHasApiKey = false;
  let memorySettingsHasVoiceId = false;
  try {
    const s = getSettings();
    memorySettingsHasApiKey = !!s.fishaudio_api_key;
    memorySettingsHasVoiceId = !!s.fishaudio_voice_id;
  } catch {
    // ignore
  }

  return {
    ...status,
    envHasApiKey,
    envHasVoiceId,
    memorySettingsHasApiKey,
    memorySettingsHasVoiceId,
  };
}

/**
 * Calls Fish Audio's TTS endpoint. The returned Response streams
 * `audio/mpeg` chunks (Transfer-Encoding: chunked) which the caller
 * can forward straight to the browser's <audio> element.
 *
 * When `voiceId` is null we omit `reference_id` entirely — Fish Audio
 * then picks a default voice, which is the user-requested behaviour
 * for "key set, voice not set".
 */
export async function streamFishAudioTts(
  config: FishAudioConfig,
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const body: Record<string, unknown> = {
    text,
    format: "mp3",
    mp3_bitrate: 128,
  };
  if (config.voiceId) body.reference_id = config.voiceId;

  return fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      model: config.model,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}
