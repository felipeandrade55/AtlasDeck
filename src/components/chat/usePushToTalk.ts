"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Push-to-talk via the space bar. Built as a deliberate backup for the
 * wake-word path: Chrome's pt-BR speech recogniser struggles with
 * short non-Portuguese trigger words ("Jarvis", "Atlas") and frequently
 * drops them entirely, so the wake never fires. With push-to-talk the
 * user holds Space, speaks, and releases — the captured transcript is
 * sent directly. No wake word needed.
 *
 * Behaviour:
 *  - Space (down) when no text input is focused → start recording
 *  - Space (up) → stop and forward the final transcript via onCommand
 *  - Pauses the wake-word recogniser while holding (only one Web Speech
 *    session is allowed per page); resumes via the `holding` state the
 *    page propagates to useWakeWord.paused
 *  - Auto-sends if a meaningful transcript was captured
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

interface UsePushToTalkOptions {
  enabled: boolean;
  lang?: string;
  onCommand: (text: string) => void;
  onInterim?: (text: string) => void;
}

export function usePushToTalk({
  enabled,
  lang = "pt-BR",
  onCommand,
  onInterim,
}: UsePushToTalkOptions) {
  const [holding, setHolding] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const accumulatedRef = useRef("");
  const onCommandRef = useRef(onCommand);
  const onInterimRef = useRef(onInterim);

  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    onInterimRef.current = onInterim;
  }, [onInterim]);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        try {
          rec.abort();
        } catch {}
      }
    }
    const captured = accumulatedRef.current.trim();
    accumulatedRef.current = "";
    setInterim("");
    setHolding(false);
    if (captured.length >= 1) {
      onCommandRef.current(captured);
    }
  }, []);

  const start = useCallback(() => {
    if (recognitionRef.current) return; // already recording
    const Ctor = getCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    accumulatedRef.current = "";
    setInterim("");

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
      onInterimRef.current?.(live);
    };
    rec.onerror = () => {
      // ignore; let onend / explicit stop handle cleanup
    };
    rec.onend = () => {
      if (recognitionRef.current === rec) {
        // Browser ended the session on its own (silence). Treat as
        // release so we still surface whatever was captured.
        recognitionRef.current = null;
        const captured = accumulatedRef.current.trim();
        accumulatedRef.current = "";
        setInterim("");
        setHolding(false);
        if (captured.length >= 1) onCommandRef.current(captured);
      }
    };

    recognitionRef.current = rec;
    setHolding(true);
    try {
      rec.start();
    } catch {
      recognitionRef.current = null;
      setHolding(false);
    }
  }, [lang]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (event.repeat) return;
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      start();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isTypingTarget(event.target)) return;
      if (!recognitionRef.current) return;
      event.preventDefault();
      stop();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, start, stop]);

  useEffect(() => () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
    }
  }, []);

  return { holding, interim, start, stop };
}
