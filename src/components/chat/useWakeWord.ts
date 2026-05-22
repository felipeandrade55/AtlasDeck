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
/**
 * Aliases are split into two tiers:
 *  - `canonical` matches anywhere with a word boundary (these are the
 *    real wake words plus very close ASR confusions that are unlikely
 *    to show up in natural pt-BR speech)
 *  - `permissive` matches *only* when it appears at the start of the
 *    utterance (or right after pause-style punctuation) — those words
 *    are common enough in everyday speech that we'd otherwise fire
 *    constantly without intent
 */
const ALIASES: Record<string, { canonical: string[]; permissive: string[] }> = {
  jarvis: {
    canonical: [
      "jarvis",
      "jarves",
      "jarvas",
      "jarbas",
      "harvis",
      "darvis",
      "djarves",
      "garvis",
      "tarvis",
    ],
    permissive: [
      // Heard in production: "Bom Jesus tudo bom" was actually "Bom dia Jarvis tudo bom"
      "jesus",
      "jesús",
      "harvey",
      "harveys",
    ],
  },
  atlas: {
    canonical: ["atlas"],
    permissive: ["atras", "atrás", "atos", "altos"],
  },
};

interface AliasSet {
  canonical: string[];
  permissive: string[];
}

function aliasesFor(phrase: string): AliasSet {
  const key = stripDiacritics(phrase.toLowerCase());
  return ALIASES[key] ?? { canonical: [key], permissive: [] };
}

export interface WakeMatch {
  phrase: string;
  alias: string;
  tail: string;
}

const boundary = (c: string): boolean => !/[a-z0-9]/.test(c);

function tryMatchAt(
  normalized: string,
  text: string,
  alias: string,
  phrase: string,
  requireTail: boolean,
): WakeMatch | null {
  const idx = normalized.indexOf(alias);
  if (idx === -1) return null;
  const before = idx === 0 ? " " : normalized[idx - 1];
  const after = normalized[idx + alias.length] ?? " ";
  if (!boundary(before) || !boundary(after)) return null;
  const tail = text.slice(idx + alias.length).trim().replace(/^[,.!?]\s*/, "");
  if (requireTail) {
    // Permissive aliases (like "jesus" / "atras") only fire when the
    // utterance has a substantial command attached. This filters out
    // casual mentions where the alias is just a word the user
    // happened to say — we'd rather miss a wake than fire wrong.
    if (tail.length < 3) return null;
  }
  return { phrase, alias, tail };
}

export function findWakeMatch(text: string, phrases: string[]): WakeMatch | null {
  const normalized = stripDiacritics(text.toLowerCase());
  for (const phrase of phrases) {
    const { canonical, permissive } = aliasesFor(phrase);
    for (const alias of canonical) {
      const m = tryMatchAt(normalized, text, alias, phrase, false);
      if (m) return m;
    }
    for (const alias of permissive) {
      const m = tryMatchAt(normalized, text, alias, phrase, true);
      if (m) return m;
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

/**
 * Window in ms during which a transcript produced after an empty wake
 * (e.g. user said just "Jarvis") is treated as the spoken command and
 * forwarded to the chat. Anything beyond this returns to normal wake
 * listening so the user does not get a stale command fired hours later.
 */
const AWAIT_COMMAND_WINDOW_MS = 10_000;

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
  const awaitingUntilRef = useRef(0);
  const lastPhraseRef = useRef<string>("Jarvis");
  const lastFiredCommandRef = useRef<string>("");
  const lastFiredAtRef = useRef(0);

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
        let interimText = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const fragment = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += fragment;
          else interimText += fragment;
        }
        const combined = (interimText + finalText).trim();
        if (!combined) return;
        setLastHeard(combined.slice(-120));
        // Debug logger — toggle with ?wake-debug in the URL.
        if (typeof window !== "undefined" && window.location?.search.includes("wake-debug")) {
          console.log("[wake] heard:", { interim: interimText, final: finalText });
        }

        const debounceFire = (command: string): boolean => {
          const sig = command.toLowerCase();
          if (!sig) return false;
          if (
            sig === lastFiredCommandRef.current &&
            Date.now() - lastFiredAtRef.current < 4000
          ) {
            return false;
          }
          lastFiredCommandRef.current = sig;
          lastFiredAtRef.current = Date.now();
          return true;
        };

        // Mode A: we are awaiting a follow-up command after a bare wake word.
        // Any reasonably long transcript that does NOT itself start with a
        // wake word is treated as the command.
        if (awaitingUntilRef.current > Date.now()) {
          const candidate = (finalText.trim() || combined).trim();
          if (
            candidate.length >= 3 &&
            !findWakeMatch(candidate, phrasesRef.current)
          ) {
            if (!debounceFire(candidate)) return;
            awaitingUntilRef.current = 0;
            setState("activated");
            try {
              onWakeRef.current({ phrase: lastPhraseRef.current, command: candidate });
            } catch {}
            try {
              rec.abort();
            } catch {}
            return;
          }
        }

        // Mode B: regular wake-word watching.
        const match = findWakeMatch(combined, phrasesRef.current);
        if (!match) return;
        const command = match.tail.trim();

        if (command.length >= 3) {
          if (!debounceFire(command)) return;
          awaitingUntilRef.current = 0;
          lastPhraseRef.current = match.phrase;
          setState("activated");
          try {
            onWakeRef.current({ phrase: match.phrase, command });
          } catch {}
          try {
            rec.abort();
          } catch {}
          return;
        }

        // Bare wake word — enter the follow-up window and let the user
        // speak the command in a fresh utterance.
        awaitingUntilRef.current = Date.now() + AWAIT_COMMAND_WINDOW_MS;
        lastPhraseRef.current = match.phrase;
        setState("activated");
        try {
          onWakeRef.current({ phrase: match.phrase, command: "" });
        } catch {}
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
