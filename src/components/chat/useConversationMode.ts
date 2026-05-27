"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Modo Conversa" — hands-free voice loop without wake-word.
 *
 * The wake-word path (useWakeWord / useOpenWakeWord / usePorcupineWakeWord)
 * trips constantly in pt-BR: Chrome's ASR mistranscribes "Jarvis" into
 * native Portuguese tokens that aren't in the alias list, openwakeword's
 * ONNX bundle breaks under Turbopack, and Porcupine needs a paid AccessKey.
 * The user shouldn't have to chant magic words to get a reply.
 *
 * This hook flips the model: ONE click to enter conversation, and from
 * that moment every utterance the user speaks is auto-forwarded as a
 * prompt. The loop:
 *
 *   1. start() → open Web Speech in continuous + interim mode (pt-BR)
 *   2. user speaks → recogniser emits `isFinal` chunks
 *   3. after `silenceMs` of no new final chunks, flush the buffer as
 *      a single utterance via `onUtterance`
 *   4. caller pauses the loop (`paused = true`) while the chat round-trip
 *      runs and TTS speaks the reply — otherwise the assistant's own
 *      voice would feed back into the mic and create a feedback storm
 *   5. caller flips `paused` back to false → loop resumes listening
 *   6. stop() → close everything
 *
 * Web Speech API gotchas this hook handles:
 *
 *  - Chrome fires `onend` after ~60s of silence even with continuous=true.
 *    We auto-restart in `onend` while the user keeps the mode on.
 *  - `start()` throws if called too quickly after a previous start. We
 *    retry with a small backoff.
 *  - The recogniser stops accepting commands during TTS playback because
 *    pausing/resuming the same instance is unreliable across Chromium
 *    versions — we fully abort + reopen instead.
 *  - The `no-speech` and `aborted` errors are normal lifecycle events,
 *    not real failures; we never bubble them up as errors.
 *
 * Returned state:
 *  - `active`: the mode is currently engaged (user pressed the button)
 *  - `listening`: an internal recogniser is open and capturing
 *  - `interim`: live partial transcript for the UI preview
 *  - `error`: a fatal error message (mic denied, browser unsupported)
 */
export type ConversationState = "off" | "listening" | "paused" | "error";

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

interface UseConversationModeOptions {
  /**
   * Master switch. When false, the loop is fully closed and the
   * microphone released. When true, the hook owns the mic until the
   * caller flips back to false.
   */
  active: boolean;
  /**
   * Soft pause used while the round-trip + TTS run. The recogniser is
   * stopped and the mic released so the assistant's own voice doesn't
   * feed back, but `active` stays true so we resume automatically when
   * paused returns to false.
   */
  paused?: boolean;
  /** BCP-47 tag, defaults to pt-BR. */
  lang?: string;
  /**
   * How long after the user goes silent before we treat the accumulated
   * transcript as a complete utterance and forward it. 1500ms is the
   * sweet spot — short enough to feel responsive, long enough for the
   * user to finish a thought with a brief mid-sentence pause.
   */
  silenceMs?: number;
  /**
   * Minimum length of an utterance before it's sent. Filters out
   * single-word noises ("uh", "hm") that would otherwise spam the chat.
   */
  minLength?: number;
  /** Fired once per utterance, after silence flush. */
  onUtterance: (text: string) => void;
  /** Live partial transcript, useful for showing what the mic hears. */
  onInterim?: (text: string) => void;
}

export function useConversationMode({
  active,
  paused = false,
  lang = "pt-BR",
  silenceMs = 1500,
  minLength = 2,
  onUtterance,
  onInterim,
}: UseConversationModeOptions) {
  const [state, setState] = useState<ConversationState>("off");
  const [supported, setSupported] = useState(true);
  const [interim, setInterim] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRequestedRef = useRef(false);
  const accumulatedRef = useRef("");
  const onUtteranceRef = useRef(onUtterance);
  const onInterimRef = useRef(onInterim);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);
  useEffect(() => {
    onInterimRef.current = onInterim;
  }, [onInterim]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Boolean(getCtor()));
  }, []);

  const flushUtterance = useCallback(() => {
    const captured = accumulatedRef.current.trim();
    accumulatedRef.current = "";
    setInterim("");
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (captured.length >= minLength) {
      try {
        onUtteranceRef.current(captured);
      } catch {
        // Caller errors must not break the loop — keep the mic alive.
      }
    }
  }, [minLength]);

  const stopInternal = useCallback(() => {
    stopRequestedRef.current = true;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        rec.abort();
      } catch {
        // ignore
      }
    }
    accumulatedRef.current = "";
    setInterim("");
    setState("off");
  }, []);

  const startInternal = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setErrorMessage("Web Speech API não disponível neste navegador (use Chrome/Edge).");
      setState("error");
      return;
    }

    let rec: RecognitionInstance;
    try {
      rec = new Ctor();
    } catch (err) {
      setErrorMessage((err as Error).message);
      setState("error");
      return;
    }

    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      setState("listening");
      setErrorMessage(null);
    };

    rec.onresult = (event: RecognitionEvent) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const fragment = result[0]?.transcript ?? "";
        if (result.isFinal) {
          accumulatedRef.current = `${accumulatedRef.current} ${fragment}`.trim();
        } else {
          interimText += fragment;
        }
      }
      const live = `${accumulatedRef.current} ${interimText}`.trim();
      setInterim(live);
      onInterimRef.current?.(live);

      // Restart the silence timer on every speech event. Once `silenceMs`
      // pass with no new speech, the accumulated transcript is flushed
      // as a single utterance.
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(flushUtterance, silenceMs);
    };

    rec.onerror = (event: Event) => {
      const code = (event as Event & { error?: string }).error;
      if (code === "no-speech" || code === "aborted") return;
      if (code === "not-allowed" || code === "service-not-allowed") {
        setErrorMessage("Microfone bloqueado. Autorize o microfone para o site.");
        setState("error");
        stopRequestedRef.current = true;
        return;
      }
      // Network / audio-capture errors are transient — onend will retry.
    };

    rec.onend = () => {
      if (stopRequestedRef.current) {
        return;
      }
      // Browser dropped the session (silence timeout or transient
      // network blip). Restart with a small backoff to avoid hammering
      // Chrome's internal rate-limit, which throws InvalidStateError
      // when start() is called too quickly after the previous end.
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        if (stopRequestedRef.current) return;
        try {
          rec.start();
        } catch {
          // Re-create from scratch if start() refuses (some Chromium
          // versions lock out reusing an aborted instance).
          recognitionRef.current = null;
          startInternal();
        }
      }, 300);
    };

    recognitionRef.current = rec;
    stopRequestedRef.current = false;
    try {
      rec.start();
    } catch (err) {
      // InvalidStateError = something else is using the mic. Bail
      // cleanly so the caller can retry after the offending instance
      // releases the device.
      setErrorMessage((err as Error).message);
      setState("error");
      recognitionRef.current = null;
    }
  }, [lang, silenceMs, flushUtterance]);

  // Drive the lifecycle from `active` and `paused`. When the user toggles
  // the mode on, we open the mic. When the caller pauses (e.g. while TTS
  // speaks the reply), we close it fully and reopen on resume — pausing
  // the same instance is too flaky across Chromium versions to rely on.
  useEffect(() => {
    if (!active || !supported) {
      stopInternal();
      return;
    }
    if (paused) {
      // Soft-pause: tear down the recogniser but keep state semantically
      // "paused" so the UI shows the mode is still engaged, just idle
      // while waiting for the reply to finish.
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      stopRequestedRef.current = true;
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (rec) {
        try {
          rec.abort();
        } catch {}
      }
      accumulatedRef.current = "";
      setInterim("");
      setState("paused");
      return;
    }
    startInternal();
    return () => {
      stopInternal();
    };
  }, [active, paused, supported, startInternal, stopInternal]);

  // Final cleanup on unmount.
  useEffect(
    () => () => {
      stopInternal();
    },
    [stopInternal],
  );

  return {
    state,
    supported,
    interim,
    errorMessage,
    /** True when the mic is actively capturing. */
    listening: state === "listening",
  };
}
