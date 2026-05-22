/**
 * ElevenLabs TTS integration.
 *
 * Reuses the same voice the user has hooked into OpenClaw for Telegram
 * audio. Configuration is resolved in priority order:
 *
 *   1. Environment variables (ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
 *      ELEVENLABS_MODEL_ID) — wins when present.
 *   2. AtlasDeck `memory_settings` (`elevenlabs_*`) — managed via the
 *      settings UI.
 *   3. OpenClaw's `openclaw.json`, probed in a handful of likely
 *      shapes since the property path is not standardised:
 *        channels.elevenlabs.{apiKey,voiceId,modelId}
 *        channels.eleven_labs.*
 *        integrations.elevenlabs.*
 *        voice.elevenlabs.*
 *        tts.elevenlabs.*
 *
 * The streaming endpoint (POST /v1/text-to-speech/{voice}/stream)
 * returns audio/mpeg as it is generated — first chunk in ~400-800ms
 * which is what makes the chat reply feel near-realtime even when the
 * upstream LLM took several seconds.
 */
import fs from "fs";
import path from "path";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { getSettings } from "@/lib/memory-db";

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  source: "env" | "memory_settings" | "openclaw.json";
}

export interface ElevenLabsStatus {
  configured: boolean;
  voiceId: string | null;
  modelId: string | null;
  source: ElevenLabsConfig["source"] | null;
}

export interface ElevenLabsDiagnostic extends ElevenLabsStatus {
  /** Which OpenClaw json paths were probed, and what we found at each. */
  probedPaths: Array<{
    path: string;
    exists: boolean;
    hasApiKey: boolean;
    hasVoiceId: boolean;
    apiKeyPreview: string | null;
    voiceIdPreview: string | null;
  }>;
  openclawJsonPath: string | null;
  openclawJsonExists: boolean;
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

function readFromEnv(): ElevenLabsConfig | null {
  const apiKey = clean(process.env.ELEVENLABS_API_KEY);
  const voiceId = clean(process.env.ELEVENLABS_VOICE_ID);
  if (!apiKey || !voiceId) return null;
  return {
    apiKey,
    voiceId,
    modelId: clean(process.env.ELEVENLABS_MODEL_ID) ?? "eleven_multilingual_v2",
    source: "env",
  };
}

function readFromMemorySettings(): ElevenLabsConfig | null {
  try {
    const s = getSettings();
    if (!s.elevenlabs_api_key || !s.elevenlabs_voice_id) return null;
    return {
      apiKey: s.elevenlabs_api_key,
      voiceId: s.elevenlabs_voice_id,
      modelId: s.elevenlabs_model_id || "eleven_multilingual_v2",
      source: "memory_settings",
    };
  } catch {
    return null;
  }
}

interface OpenClawCandidate {
  apiKey?: unknown;
  api_key?: unknown;
  key?: unknown;
  voiceId?: unknown;
  voice_id?: unknown;
  voice?: unknown;
  modelId?: unknown;
  model_id?: unknown;
  model?: unknown;
}

function extractCandidate(node: unknown): ElevenLabsConfig | null {
  if (!node || typeof node !== "object") return null;
  const c = node as OpenClawCandidate;
  const apiKey = clean(c.apiKey) ?? clean(c.api_key) ?? clean(c.key);
  const voiceId = clean(c.voiceId) ?? clean(c.voice_id) ?? clean(c.voice);
  if (!apiKey || !voiceId) return null;
  return {
    apiKey,
    voiceId,
    modelId:
      clean(c.modelId) ??
      clean(c.model_id) ??
      clean(c.model) ??
      "eleven_multilingual_v2",
    source: "openclaw.json",
  };
}

function readFromOpenClawJson(): ElevenLabsConfig | null {
  try {
    const dir = readOpenClawConfig().openclawDir;
    const configPath = path.join(dir, "openclaw.json");
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const integrations = cfg.integrations as Record<string, unknown> | undefined;
    const voice = cfg.voice as Record<string, unknown> | undefined;
    const tts = cfg.tts as Record<string, unknown> | undefined;
    const candidates: unknown[] = [
      channels?.elevenlabs,
      channels?.eleven_labs,
      channels?.["eleven-labs"],
      integrations?.elevenlabs,
      integrations?.eleven_labs,
      voice?.elevenlabs,
      voice?.eleven_labs,
      tts?.elevenlabs,
      tts?.eleven_labs,
    ];
    for (const c of candidates) {
      const parsed = extractCandidate(c);
      if (parsed) return parsed;
    }
  } catch {
    // ignore — config unreadable means no ElevenLabs available
  }
  return null;
}

export function readElevenLabsConfig(): ElevenLabsConfig | null {
  return readFromEnv() ?? readFromMemorySettings() ?? readFromOpenClawJson();
}

export function elevenLabsStatus(): ElevenLabsStatus {
  const config = readElevenLabsConfig();
  if (!config) {
    return { configured: false, voiceId: null, modelId: null, source: null };
  }
  return {
    configured: true,
    voiceId: config.voiceId,
    modelId: config.modelId,
    source: config.source,
  };
}

function preview(value: string, keepHead = 4, keepTail = 4): string {
  if (value.length <= keepHead + keepTail) return value;
  return `${value.slice(0, keepHead)}…${value.slice(-keepTail)}`;
}

const PROBE_PATHS: Array<{ key: string; pick: (cfg: Record<string, unknown>) => unknown }> = [
  { key: "channels.elevenlabs", pick: (c) => (c.channels as Record<string, unknown> | undefined)?.elevenlabs },
  { key: "channels.eleven_labs", pick: (c) => (c.channels as Record<string, unknown> | undefined)?.eleven_labs },
  { key: "channels.eleven-labs", pick: (c) => (c.channels as Record<string, unknown> | undefined)?.["eleven-labs"] },
  { key: "integrations.elevenlabs", pick: (c) => (c.integrations as Record<string, unknown> | undefined)?.elevenlabs },
  { key: "integrations.eleven_labs", pick: (c) => (c.integrations as Record<string, unknown> | undefined)?.eleven_labs },
  { key: "voice.elevenlabs", pick: (c) => (c.voice as Record<string, unknown> | undefined)?.elevenlabs },
  { key: "voice.eleven_labs", pick: (c) => (c.voice as Record<string, unknown> | undefined)?.eleven_labs },
  { key: "tts.elevenlabs", pick: (c) => (c.tts as Record<string, unknown> | undefined)?.elevenlabs },
  { key: "tts.eleven_labs", pick: (c) => (c.tts as Record<string, unknown> | undefined)?.eleven_labs },
];

/**
 * Verbose status used by the UI's diagnostic modal. We never return
 * the full API key/voice id — only short head/tail previews — so the
 * endpoint stays safe to surface from the browser.
 */
export function elevenLabsDiagnostic(): ElevenLabsDiagnostic {
  const status = elevenLabsStatus();

  const envHasApiKey = !!clean(process.env.ELEVENLABS_API_KEY);
  const envHasVoiceId = !!clean(process.env.ELEVENLABS_VOICE_ID);

  let memorySettingsHasApiKey = false;
  let memorySettingsHasVoiceId = false;
  try {
    const s = getSettings();
    memorySettingsHasApiKey = !!s.elevenlabs_api_key;
    memorySettingsHasVoiceId = !!s.elevenlabs_voice_id;
  } catch {
    // ignore
  }

  let openclawJsonPath: string | null = null;
  let openclawJsonExists = false;
  const probedPaths: ElevenLabsDiagnostic["probedPaths"] = [];

  try {
    const dir = readOpenClawConfig().openclawDir;
    openclawJsonPath = path.join(dir, "openclaw.json");
    openclawJsonExists = fs.existsSync(openclawJsonPath);

    if (openclawJsonExists) {
      const cfg = JSON.parse(fs.readFileSync(openclawJsonPath, "utf-8")) as Record<string, unknown>;
      for (const probe of PROBE_PATHS) {
        const node = probe.pick(cfg);
        if (!node || typeof node !== "object") {
          probedPaths.push({
            path: probe.key,
            exists: false,
            hasApiKey: false,
            hasVoiceId: false,
            apiKeyPreview: null,
            voiceIdPreview: null,
          });
          continue;
        }
        const c = node as OpenClawCandidate;
        const apiKey = clean(c.apiKey) ?? clean(c.api_key) ?? clean(c.key);
        const voiceId = clean(c.voiceId) ?? clean(c.voice_id) ?? clean(c.voice);
        probedPaths.push({
          path: probe.key,
          exists: true,
          hasApiKey: !!apiKey,
          hasVoiceId: !!voiceId,
          apiKeyPreview: apiKey ? preview(apiKey) : null,
          voiceIdPreview: voiceId ? preview(voiceId) : null,
        });
      }
    }
  } catch {
    // ignore
  }

  return {
    ...status,
    probedPaths,
    openclawJsonPath,
    openclawJsonExists,
    envHasApiKey,
    envHasVoiceId,
    memorySettingsHasApiKey,
    memorySettingsHasVoiceId,
  };
}

/**
 * Calls ElevenLabs' streaming TTS endpoint. The returned Response
 * carries an `audio/mpeg` body that the caller can pipe straight to
 * the browser — chunks arrive as ElevenLabs synthesises them so the
 * browser's <audio> element starts playing well before the full clip
 * is rendered.
 */
export async function streamElevenLabsTts(
  config: ElevenLabsConfig,
  text: string,
  opts: { stability?: number; similarity?: number; style?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream?optimize_streaming_latency=2&output_format=mp3_44100_128`;
  return fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: config.modelId,
      voice_settings: {
        stability: opts.stability ?? 0.45,
        similarity_boost: opts.similarity ?? 0.85,
        style: opts.style ?? 0.0,
        use_speaker_boost: true,
      },
    }),
    signal: opts.signal,
  });
}
