"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechSynthesis } from "./useSpeechSynthesis";

export type TtsEngine = "elevenlabs" | "web_speech";

interface ElevenLabsConfigStatus {
  configured: boolean;
  voiceId: string | null;
}

/**
 * Single TTS entry point used by the chat UI. Prefers ElevenLabs (same
 * voice the user already hears via Telegram) and silently falls back
 * to the browser's Web Speech API when ElevenLabs is not configured or
 * fails — so the page never goes silent because of a backend hiccup.
 *
 * The hook also exposes `engine` and `cancel` so the page can render a
 * "Voz: ElevenLabs / Web" badge and stop playback when the user starts
 * speaking again.
 */
export function useTtsEngine() {
  const fallback = useSpeechSynthesis();
  const [engine, setEngine] = useState<TtsEngine>("web_speech");
  const [voiceLabel, setVoiceLabel] = useState<string>("Web Speech");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/chat/tts");
        if (!res.ok) return;
        const status = (await res.json()) as ElevenLabsConfigStatus;
        if (!alive) return;
        if (status.configured) {
          setEngine("elevenlabs");
          setVoiceLabel(status.voiceId ? `ElevenLabs · ${status.voiceId.slice(0, 8)}` : "ElevenLabs");
        }
      } catch {
        // Keep web_speech default
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  const speakViaElevenLabs = useCallback(
    async (text: string): Promise<boolean> => {
      cancelledRef.current = false;
      const res = await fetch("/api/chat/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) {
        return false;
      }
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
          resolve(false);
        };
        audio.play().catch(() => {
          cleanupAudio();
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

      if (engine === "elevenlabs") {
        try {
          const ok = await speakViaElevenLabs(text);
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
    [engine, fallback, speakViaElevenLabs, cancel],
  );

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  return {
    speak,
    cancel,
    engine,
    voiceLabel,
    supported: fallback.supported || engine === "elevenlabs",
  };
}
