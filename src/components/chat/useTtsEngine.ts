"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TtsEngine = "elevenlabs" | "fishaudio" | "web_speech";

interface ActiveTtsStatus {
  provider: "elevenlabs" | "fishaudio" | null;
  configured: boolean;
  voiceId: string | null;
  source?: string | null;
  preferred?: "elevenlabs" | "fishaudio";
}

const MAX_TTS_CHARS = 4500;

function splitForTts(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_TTS_CHARS) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_TTS_CHARS) {
    const window = remaining.slice(0, MAX_TTS_CHARS);
    const splitAt = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("; "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    );
    const cut = splitAt > MAX_TTS_CHARS * 0.6 ? splitAt + 1 : MAX_TTS_CHARS;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Single TTS entry point used by the chat UI. Prefers the user's
 * selected cloud provider (ElevenLabs or Fish Audio) exposed by
 * `/api/chat/tts`.
 *
 * `engine` and `voiceLabel` let the page render a "Voz: 11labs / fish /
 * not configured" badge; `cancel` stops playback when the user starts speaking.
 */
export function useTtsEngine() {
  const [engine, setEngine] = useState<TtsEngine>("web_speech");
  const [voiceLabel, setVoiceLabel] = useState<string>("TTS não configurado");
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [preferred, setPreferred] = useState<"elevenlabs" | "fishaudio" | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/tts");
      if (!res.ok) return;
      const status = (await res.json()) as ActiveTtsStatus;
      setConfigured(status.configured);
      setSource(status.source ?? null);
      setPreferred(status.preferred ?? status.provider ?? null);
      if (status.configured && status.provider) {
        setEngine(status.provider);
        const name = status.provider === "fishaudio" ? "FishAudio" : "ElevenLabs";
        setVoiceLabel(
          status.voiceId
            ? `${name} · ${status.voiceId.slice(0, 8)}`
            : `${name} · default`,
        );
      } else {
        setEngine("web_speech");
        setVoiceLabel("TTS não configurado");
      }
    } catch {
      // Keep current engine
    }
  }, []);

  useEffect(() => {
    // Initial detection on mount — refreshing settings re-fires via the
    // dedicated `refresh()` method when the user saves the modal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cleanupAudio();
  }, [cleanupAudio]);

  const speakViaCloud = useCallback(
    async (text: string): Promise<boolean> => {
      cancelledRef.current = false;
      const res = await fetch("/api/chat/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) {
        // Surface the upstream error so the page can show a toast — the
        // silent fallback to Web Speech was hiding Fish Audio / ElevenLabs
        // misconfiguration and making the user think TTS was just broken.
        let detail = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (typeof data?.error === "string") detail = data.error;
        } catch {
          try {
            const text = await res.text();
            if (text) detail = text.slice(0, 240);
          } catch {}
        }
        setLastError(detail);
        return false;
      }
      // Clear any previous error since the cloud TTS just worked.
      setLastError(null);
      const blob = await res.blob();
      if (cancelledRef.current) return true;
      const url = URL.createObjectURL(blob);
      cleanupAudio();
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      return new Promise<boolean>((resolve) => {
        audio.onended = () => {
          cleanupAudio();
          resolve(true);
        };
        audio.onerror = () => {
          cleanupAudio();
          setLastError("Falha ao reproduzir áudio do TTS no <audio>");
          resolve(false);
        };
        audio.play().catch((err) => {
          cleanupAudio();
          setLastError(`Browser bloqueou play(): ${(err as Error).message}`);
          resolve(false);
        });
      });
    },
    [cleanupAudio],
  );

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      cancel();
      cancelledRef.current = false;

      if (engine === "elevenlabs" || engine === "fishaudio") {
        try {
          for (const chunk of splitForTts(text)) {
            if (cancelledRef.current) return;
            const ok = await speakViaCloud(chunk);
            if (!ok) return;
          }
          return;
        } catch (err) {
          setLastError((err as Error).message);
        }
        return;
      }
      setLastError(
        "Nenhum TTS cloud configurado. Configure Fish Audio ou ElevenLabs em Voz do Jarvis.",
      );
    },
    [engine, speakViaCloud, cancel],
  );

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  return {
    speak,
    cancel,
    refresh,
    engine,
    voiceLabel,
    configured,
    source,
    preferred,
    lastError,
    clearError: () => setLastError(null),
    // Keep `supported` true so callers can surface configuration/provider
    // errors instead of silently skipping speech.
    supported: true,
  };
}
