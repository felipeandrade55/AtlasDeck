"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin wrapper over window.speechSynthesis. Provides:
 *  - speak(text, opts)  -> queue an utterance, returns a promise that
 *    resolves when playback completes (or rejects on error)
 *  - cancel()           -> stop everything in the queue
 *  - voices             -> reactive list of available voices for UI selectors
 */
export interface SpeakOptions {
  lang?: string;
  voiceName?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export function useSpeechSynthesis() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(true);
  const isSpeakingRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSupported(false);
      return;
    }
    const synth = window.speechSynthesis;
    const updateVoices = () => setVoices(synth.getVoices());
    updateVoices();
    synth.addEventListener("voiceschanged", updateVoices);
    return () => synth.removeEventListener("voiceschanged", updateVoices);
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    isSpeakingRef.current = false;
  }, []);

  const speak = useCallback(
    (text: string, opts: SpeakOptions = {}) =>
      new Promise<void>((resolve, reject) => {
        if (typeof window === "undefined" || !window.speechSynthesis) {
          resolve();
          return;
        }
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = opts.lang ?? "pt-BR";
        utter.rate = opts.rate ?? 1.05;
        utter.pitch = opts.pitch ?? 1;
        utter.volume = opts.volume ?? 1;

        if (opts.voiceName) {
          const match = window.speechSynthesis
            .getVoices()
            .find((v) => v.name === opts.voiceName);
          if (match) utter.voice = match;
        }

        utter.onend = () => {
          isSpeakingRef.current = false;
          resolve();
        };
        utter.onerror = (event) => {
          isSpeakingRef.current = false;
          reject(new Error(`TTS error: ${event.error}`));
        };
        isSpeakingRef.current = true;
        window.speechSynthesis.speak(utter);
      }),
    [],
  );

  return { speak, cancel, voices, supported };
}
