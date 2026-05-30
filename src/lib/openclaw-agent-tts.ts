/**
 * Wires Fish Audio (already integrated AtlasDeck-side in src/lib/fishaudio.ts
 * + persisted in memory_settings) into OpenClaw's agent TTS config so the
 * gateway auto-applies cloned-voice synthesis on inbound-audio WhatsApp
 * replies (modo Owner).
 *
 * OpenClaw's dispatch layer already calls maybeApplyTtsToReplyPayload()
 * before sending to channels — it just needs to FIND a provider config at
 * `agents.list[<id>].tts.providers.fishaudio.*` with auto="inbound" so it
 * triggers on audio-to-audio. This helper builds that block from the user's
 * stored credentials.
 *
 * If the user hasn't configured Fish Audio yet (no api_key OR no voice_id),
 * we DON'T write a half-broken tts block — better to leave the agent
 * text-only than ship a config that crashes the gateway on the first audio.
 */
import { getSettings, type MemorySettings } from "./memory-db";

const DEFAULT_AGENT_ID = "main";

export interface AgentTtsBlock {
  auto: "inbound";
  provider: "fishaudio";
  providers: {
    fishaudio: {
      apiKey: string;
      voiceId: string;
      model: string;
    };
  };
}

/**
 * Returns the TTS block to write into agents.list[<id>].tts, or null when
 * the user hasn't finished Fish Audio setup. Callers should use null as
 * "don't touch agent's existing tts config — delete the field if it's
 * already there from a previous owner-mode save".
 */
export function buildAgentTtsBlock(settings?: MemorySettings): AgentTtsBlock | null {
  const s = settings ?? getSettings();
  const apiKey = s.fishaudio_api_key?.trim();
  const voiceId = s.fishaudio_voice_id?.trim();
  if (!apiKey || !voiceId) return null;
  return {
    auto: "inbound",
    provider: "fishaudio",
    providers: {
      fishaudio: {
        apiKey,
        voiceId,
        model: s.fishaudio_model || "s2-pro",
      },
    },
  };
}

/**
 * In-place mutation: install or remove the tts block on the target agent.
 * Pass `block=null` to remove. Returns true when the config was changed.
 *
 * Looks up the agent by id in `raw.agents.list[]` and modifies in place.
 * Falls back to creating the entry skeleton if the agent isn't there yet
 * (rare — fresh installs always have at least the "main" agent).
 */
export function applyAgentTtsBlock(
  raw: Record<string, unknown>,
  block: AgentTtsBlock | null,
  agentId: string = DEFAULT_AGENT_ID,
): boolean {
  const agents = (raw.agents && typeof raw.agents === "object" ? raw.agents : {}) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(agents.list) ? (agents.list as Record<string, unknown>[]) : [];
  let entry = list.find((a) => a && a.id === agentId);
  if (!entry) {
    entry = { id: agentId };
    list.push(entry);
  }

  const before = JSON.stringify(entry.tts ?? null);
  if (block) {
    entry.tts = block;
  } else if ("tts" in entry) {
    delete entry.tts;
  }
  const after = JSON.stringify(entry.tts ?? null);
  if (before === after) return false;

  raw.agents = { ...agents, list };
  return true;
}
