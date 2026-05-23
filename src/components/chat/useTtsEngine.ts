"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechSynthesis } from "./useSpeechSynthesis";

export type TtsEngine = "elevenlabs" | "fishaudio" | "web_speech";

interface ActiveTtsStatus {
  provider: "elevenlabs" | "fishaudio" | null;
  configured: boolean;
  voiceId: string | null;
}

/**
 * Single TTS entry point used by the chat UI. Prefers the user's
 * selected cloud provider (ElevenLabs or Fish Audio) exposed by
 * `/api/chat/tts`, and silently falls back to Web Speech when neither
 * is configured or the request fails — so the page never goes silent
 * because of a backend hiccup.
 *
 * `engine` and `voiceLabel` let the page render a "Voz: 11labs / fish /
 * web" badge; `cancel` stops playback when the user starts speaking.
 */
export function useTtsEngine() {
  const fallback = useSpeechSynthesis();
  const [engine, setEngine] = useState<TtsEngine>("web_speech");
  const [voiceLabel, setVoiceLabel] = useState<string>("Web Speech");
  const [lastError, setLastError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/tts");
      if (!res.ok) return;
      const status = (await res.json()) as ActiveTtsStatus;
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
        setVoiceLabel("Web Speech");
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
    fallback.cancel();
  }, [cleanupAudio, fallback]);

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
          const ok = await speakViaCloud(text);
          if (ok) return;
        } catch {
          // fall through to fallback
        }
      }
      try {
        await fallback.speak(text, { lang: "pt-BR" });
      } catch {
        // give up silently
      }
    },
    [engine, fallback, speakViaCloud, cancel],
  );

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  return {
    speak,
    cancel,
    refresh,
    engine,
    voiceLabel,
    lastError,
    clearError: () => setLastError(null),
    supported:
      fallback.supported || engine === "elevenlabs" || engine === "fishaudio",
  };
}
