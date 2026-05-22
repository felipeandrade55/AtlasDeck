"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BuiltInKeyword, PorcupineWorker } from "@picovoice/porcupine-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

/**
 * Acoustic wake-word detection via Picovoice Porcupine.
 *
 * Unlike Web Speech, Porcupine ships pre-trained models that recognise
 * fixed wake words (Jarvis, Alexa, Computer, …) from raw audio frames
 * — it does not depend on the browser's ASR being able to transcribe
 * the trigger. That solves the pt-BR limitation where "Jarvis" gets
 * mistranscribed as "Jesus" or "AL".
 *
 * Setup:
 *  - User creates a free account at https://console.picovoice.ai/
 *  - Copies the AccessKey into AtlasDeck (VoiceSettingsModal)
 *  - The english model lives at /porcupine_params.pv (downloaded once
 *    at install/dev time and shipped in public/)
 *
 * After wake fires, the page hands control over to Web Speech for
 * command capture — which is reliable for full pt-BR sentences.
 */
export type PorcupineState = "off" | "loading" | "listening" | "activated" | "error";

interface UsePorcupineOptions {
  enabled: boolean;
  paused?: boolean;
  onWake: () => void;
}

interface SecretConfig {
  accessKey: string;
  keyword: string;
}

function isBuiltIn(keyword: string): keyword is BuiltInKeyword {
  return Object.values(BuiltInKeyword).includes(keyword as BuiltInKeyword);
}

export function usePorcupineWakeWord({
  enabled,
  paused = false,
  onWake,
}: UsePorcupineOptions) {
  const [state, setState] = useState<PorcupineState>("off");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const workerRef = useRef<PorcupineWorker | null>(null);
  const subscribedRef = useRef(false);
  const onWakeRef = useRef(onWake);
  const startingRef = useRef(false);

  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  // Check whether Porcupine is configured. We do this once per mount so
  // the hook stays cheap when the user has not set up an access key.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/chat/wake-config");
        if (!res.ok) {
          if (alive) setAvailable(false);
          return;
        }
        const data = (await res.json()) as { configured: boolean };
        if (alive) setAvailable(Boolean(data.configured));
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const stop = useCallback(async () => {
    if (workerRef.current) {
      try {
        if (subscribedRef.current) {
          await WebVoiceProcessor.unsubscribe(workerRef.current);
          subscribedRef.current = false;
        }
      } catch {}
      try {
        workerRef.current.terminate();
      } catch {}
      workerRef.current = null;
    }
    setState("off");
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || workerRef.current) return;
    startingRef.current = true;
    setState("loading");
    setErrorMessage(null);
    try {
      const secret = await fetch("/api/chat/wake-config/secret");
      if (!secret.ok) {
        throw new Error("Access key não disponível (configure em Settings).");
      }
      const cfg = (await secret.json()) as SecretConfig;
      const keywordName = isBuiltIn(cfg.keyword) ? cfg.keyword : BuiltInKeyword.Jarvis;

      const worker = await PorcupineWorker.create(
        cfg.accessKey,
        [keywordName as BuiltInKeyword],
        () => {
          setState("activated");
          try {
            onWakeRef.current();
          } catch {
            // ignore — keep listening
          }
        },
        { publicPath: "/porcupine_params.pv" },
      );
      workerRef.current = worker;
      await WebVoiceProcessor.subscribe(worker);
      subscribedRef.current = true;
      setState("listening");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setState("error");
      await stop();
    } finally {
      startingRef.current = false;
    }
  }, [stop]);

  useEffect(() => {
    if (!enabled || paused || available === false || available === null) {
      if (workerRef.current) {
        void stop();
      }
      return;
    }
    void start();
  }, [enabled, paused, available, start, stop]);

  useEffect(
    () => () => {
      void stop();
    },
    [stop],
  );

  return {
    state,
    available,
    errorMessage,
    /** Returns true while the hook actively owns the microphone. */
    holding: state === "listening" || state === "activated" || state === "loading",
  };
}
