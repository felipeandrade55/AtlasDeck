"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * After Porcupine fires "wake detected" we still need to capture the
 * user's actual command. Porcupine itself only signals the trigger, so
 * we briefly hand the microphone to Web Speech and ride it until the
 * user pauses. Then we forward the transcript and shut the recogniser
 * down so Porcupine can resume listening.
 *
 * This is a one-shot capture: each call to `arm()` opens a single
 * Web Speech session with a 1.5s silence timeout. If the silence
 * timeout fires without any final transcript, we just cancel and let
 * Porcupine listen again.
 */
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

const SILENCE_MS = 1800;
const MAX_SESSION_MS = 10_000;

interface UseFollowUpCaptureOptions {
  lang?: string;
  onCommand: (text: string) => void;
  onCancel?: () => void;
}

export function useFollowUpCapture({
  lang = "pt-BR",
  onCommand,
  onCancel,
}: UseFollowUpCaptureOptions) {
  const [active, setActive] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedRef = useRef("");
  const onCommandRef = useRef(onCommand);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const finalize = useCallback((reason: "command" | "cancel") => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
    silenceTimerRef.current = null;
    sessionTimerRef.current = null;
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        rec.abort();
      } catch {}
    }
    const captured = accumulatedRef.current.trim();
    accumulatedRef.current = "";
    setInterim("");
    setActive(false);
    if (reason === "command" && captured) {
      onCommandRef.current(captured);
    } else {
      onCancelRef.current?.();
    }
  }, []);

  const arm = useCallback(() => {
    if (recognitionRef.current) return; // already armed
    const Ctor = getCtor();
    if (!Ctor) {
      onCancelRef.current?.();
      return;
    }
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    accumulatedRef.current = "";
    setInterim("");

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => finalize("command"), SILENCE_MS);
    };

    rec.onresult = (event) => {
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
      if (live) resetSilenceTimer();
    };
    rec.onerror = () => {
      // ignore — let session timer or onend handle cleanup
    };
    rec.onend = () => {
      if (recognitionRef.current === rec) {
        // Browser ended on its own (silence). Surface whatever was captured.
        finalize("command");
      }
    };

    recognitionRef.current = rec;
    setActive(true);
    sessionTimerRef.current = setTimeout(() => finalize("command"), MAX_SESSION_MS);
    resetSilenceTimer();
    try {
      rec.start();
    } catch {
      finalize("cancel");
    }
  }, [lang, finalize]);

  const cancel = useCallback(() => finalize("cancel"), [finalize]);

  useEffect(
    () => () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {}
    },
    [],
  );

  return { arm, cancel, active, interim };
}
