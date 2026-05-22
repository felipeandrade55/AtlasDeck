"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

/**
 * Web Speech API microphone button. Streams partial transcripts via
 * onInterim and emits the final string via onFinal. Falls back to a
 * disabled state when the browser does not expose SpeechRecognition.
 *
 * Whisper-local engine support comes later behind a settings flag.
 */
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionInstance;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface MicButtonProps {
  lang?: string;
  disabled?: boolean;
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
}

export function MicButton({
  lang = "pt-BR",
  disabled,
  onInterim,
  onFinal,
}: MicButtonProps) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    // Browser-only feature detection — safe to setState here because the
    // value is unknown until hydration and we need a one-shot probe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Boolean(getRecognitionCtor()));
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setRecording(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }

    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript;
        if (res.isFinal) final += transcript;
        else interim += transcript;
      }
      if (interim) onInterim?.(interim);
      if (final) {
        onFinal(final.trim());
      }
    };

    rec.onerror = () => {
      setRecording(false);
    };
    rec.onend = () => {
      setRecording(false);
    };

    recognitionRef.current = rec;
    setRecording(true);
    try {
      rec.start();
    } catch {
      setRecording(false);
    }
  }, [lang, onFinal, onInterim]);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  if (!supported) {
    return (
      <button
        type="button"
        disabled
        title="Reconhecimento de voz indisponível neste navegador"
        style={iconButtonStyle({ disabled: true })}
      >
        <MicOff size={18} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={recording ? stop : start}
      disabled={disabled}
      title={recording ? "Parar gravação" : "Falar"}
      aria-pressed={recording}
      style={iconButtonStyle({
        disabled,
        active: recording,
      })}
    >
      <Mic size={18} />
      {recording && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            border: "2px solid var(--accent)",
            animation: "pulse 1.2s infinite",
            pointerEvents: "none",
          }}
        />
      )}
    </button>
  );
}

function iconButtonStyle({
  disabled,
  active,
}: {
  disabled?: boolean;
  active?: boolean;
}): React.CSSProperties {
  return {
    position: "relative",
    width: 36,
    height: 36,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: active ? "var(--accent-soft)" : "var(--surface)",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
