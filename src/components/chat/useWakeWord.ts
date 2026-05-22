"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-side wake-word detector built on top of the Web Speech API in
 * continuous mode. While `enabled` is true, the recognizer keeps an
 * always-on session listening for any of the configured phrases.
 *
 * When a phrase is heard, two behaviors trigger:
 *  - If the transcript contains additional words after the wake phrase
 *    (e.g. "atlas qual a previsão"), `onWake` is called with that command
 *    and the listener restarts to keep watching for the next call.
 *  - If only the wake phrase was heard, `state` flips to `activated` so
 *    the UI can prompt the user to speak the command via the Composer.
 *
 * This is the zero-install path. A future upgrade will swap the engine
 * for openwakeword (ONNX) when better accuracy / privacy is needed.
 */
export type WakeState = "off" | "listening" | "activated" | "error";

interface RecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}
interface RecognitionEvent extends Event {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface RecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
interface RecognitionCtor {
  new (): RecognitionInstance;
}

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Brazilian Portuguese ASR engines often mistranscribe "Jarvis" as
 * a handful of close-sounding native words. We accept these as aliases
 * so the wake word still fires when the recognizer hears one of them.
 * The aliases live in normalized form (lowercase, no diacritics).
 */
const ALIASES: Record<string, string[]> = {
  jarvis: ["jarvis", "jarves", "jarvas", "jarbas", "harvey", "harvis", "darvis", "javes"],
  atlas: ["atlas", "atras", "atras."],
};

function aliasesFor(phrase: string): string[] {
  const key = stripDiacritics(phrase.toLowerCase());
  return ALIASES[key] ?? [key];
}

export interface WakeMatch {
  phrase: string;
  alias: string;
  tail: string;
}

export function findWakeMatch(text: string, phrases: string[]): WakeMatch | null {
  const normalized = stripDiacritics(text.toLowerCase());
  for (const phrase of phrases) {
    for (const alias of aliasesFor(phrase)) {
      const idx = normalized.indexOf(alias);
      if (idx === -1) continue;
      // Accept any boundary that is not letter/number to keep noisy
      // transcripts (no spacing) from blocking the match.
      const before = idx === 0 ? " " : normalized[idx - 1];
      const after = normalized[idx + alias.length] ?? " ";
      const boundary = (c: string) => !/[a-z0-9]/.test(c);
      if (!boundary(before) || !boundary(after)) continue;
      const tail = text.slice(idx + alias.length).trim().replace(/^[,.!?]\s*/, "");
      return { phrase, alias, tail };
    }
  }
  return null;
}

interface UseWakeWordOptions {
  enabled: boolean;
  /**
   * Temporary suspension without resetting state (e.g. while the
   * assistant is speaking via TTS or the manual mic button is open).
   */
  paused?: boolean;
  phrases: string[];
  lang?: string;
  onWake: (payload: { phrase: string; command: string }) => void;
}

export function useWakeWord({
  enabled,
  paused = false,
  phrases,
  lang = "pt-BR",
  onWake,
}: UseWakeWordOptions) {
  const [state, setState] = useState<WakeState>("off");
  const [supported, setSupported] = useState(true);
  const [lastHeard, setLastHeard] = useState<string>("");
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRequestedRef = useRef(false);
  const phrasesRef = useRef(phrases);
  const onWakeRef = useRef(onWake);
  const startInternalRef = useRef<() => void>(() => {});

  useEffect(() => {
    phrasesRef.current = phrases;
  }, [phrases]);
  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Boolean(getCtor()));
  }, []);

  const startInternal = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setState("error");
      return;
    }

    try {
      const rec = new Ctor();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;

      rec.onstart = () => setState("listening");
      rec.onresult = (event) => {
        let text = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          text += event.results[i][0].transcript;
        }
        const trimmed = text.trim();
        if (!trimmed) return;
        setLastHeard(trimmed.slice(-120));
        // Log only when debug is on so production console stays clean.
        if (typeof window !== "undefined" && window.location?.search.includes("wake-debug")) {
          console.log("[wake] heard:", trimmed);
        }
        const match = findWakeMatch(trimmed, phrasesRef.current);
        if (!match) return;
        const command = match.tail.trim();
        setState("activated");
        try {
          onWakeRef.current({ phrase: match.phrase, command });
        } catch {
          // user callback errored — keep listening
        }
        // Reset: abort current session and immediately restart
        stopRequestedRef.current = false;
        try {
          rec.abort();
        } catch {}
      };
      rec.onerror = (event: Event) => {
        const code = (event as Event & { error?: string }).error;
        if (code === "no-speech" || code === "aborted") return;
        setState("error");
      };
      rec.onend = () => {
        if (stopRequestedRef.current) {
          setState("off");
          return;
        }
        // Auto-restart with small backoff to avoid hammering the engine
        restartTimerRef.current = setTimeout(() => {
          try {
            rec.start();
          } catch {
            // Some browsers throw if start is called too quickly; let next tick retry.
            restartTimerRef.current = setTimeout(() => startInternalRef.current(), 300);
          }
        }, 250);
      };

      recognitionRef.current = rec;
      stopRequestedRef.current = false;
      rec.start();
    } catch {
      setState("error");
    }
  }, [lang]);

  useEffect(() => {
    startInternalRef.current = startInternal;
  }, [startInternal]);

  const stopInternal = useCallback(() => {
    stopRequestedRef.current = true;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    try {
      recognitionRef.current?.abort();
    } catch {}
    recognitionRef.current = null;
    setState("off");
  }, []);

  useEffect(() => {
    if (!enabled || !supported || paused) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      stopInternal();
      return;
    }
    startInternal();
    return stopInternal;
  }, [enabled, paused, supported, startInternal, stopInternal]);

  return { state, supported, lastHeard };
}
