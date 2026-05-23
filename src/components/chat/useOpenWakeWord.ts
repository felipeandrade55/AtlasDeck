"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Model as OwwModelType, PredictionResult } from "openwakeword-js";

/**
 * Wake-word detection via openWakeWord (Apache-2.0).
 *
 * Runs three small ONNX models entirely in the browser using
 * onnxruntime-web — no AccessKey, no account, no commercial gate.
 * The pipeline is:
 *
 *   mic 16kHz mono -> melspectrogram -> embedding -> wake classifier
 *
 * The classifier emits a probability per registered keyword on every
 * audio frame; when the probability crosses `threshold`, `onWake`
 * fires. The hook owns the microphone, the AudioContext, and the
 * underlying Model instance, releasing them when `enabled` flips off.
 *
 * Assets served from `/openwakeword/`:
 *   - melspectrogram.onnx (~1MB)
 *   - embedding_model.onnx (~1.3MB)
 *   - hey_jarvis_v0.1.onnx (~1.2MB)
 *   - silero_vad.onnx (~1.7MB, used by the built-in VAD gate)
 *   - ort-wasm-simd-threaded.{wasm,mjs} (onnxruntime-web runtime)
 */
export type OwwState =
  | "off"
  | "loading"
  | "listening"
  | "activated"
  | "error";

interface UseOpenWakeWordOptions {
  enabled: boolean;
  paused?: boolean;
  threshold?: number;
  onWake: () => void;
}

const PUBLIC_BASE = "/openwakeword/";
const CHUNK_SAMPLES = 1280; // 80ms at 16kHz — openwakeword's expected input
const ENGINE_KEY = "hey_jarvis_v0.1";

export function useOpenWakeWord({
  enabled,
  paused = false,
  threshold = 0.5,
  onWake,
}: UseOpenWakeWordOptions) {
  const [state, setState] = useState<OwwState>("off");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastScore, setLastScore] = useState<number>(0);

  const modelRef = useRef<OwwModelType | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Float32Array>(new Float32Array(0));
  const startingRef = useRef(false);
  const onWakeRef = useRef(onWake);
  const thresholdRef = useRef(threshold);
  const lastFireRef = useRef(0);

  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);
  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  const stop = useCallback(() => {
    try {
      processorRef.current?.disconnect();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    try {
      audioCtxRef.current?.close();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {}
    });
    processorRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    if (modelRef.current) {
      try {
        modelRef.current.reset();
      } catch {}
      modelRef.current = null;
    }
    audioQueueRef.current = new Float32Array(0);
    setState("off");
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || modelRef.current) return;
    startingRef.current = true;
    setState("loading");
    setErrorMessage(null);
    try {
      // Lazy import keeps the ONNX runtime off the initial bundle. The
      // hook only loads it when wake-word is actually enabled.
      const { Model } = await import("openwakeword-js");
      const model = new Model({
        wakewordModels: [`${PUBLIC_BASE}${ENGINE_KEY}.onnx`],
        melspectrogramModelPath: `${PUBLIC_BASE}melspectrogram.onnx`,
        embeddingModelPath: `${PUBLIC_BASE}embedding_model.onnx`,
        vadModelPath: `${PUBLIC_BASE}silero_vad.onnx`,
        vadThreshold: 0.5,
        thresholds: { [ENGINE_KEY]: thresholdRef.current },
        debounceTime: 2,
        inferenceFramework: "onnx",
        wasmPaths: PUBLIC_BASE,
      });
      await model.init();
      modelRef.current = model;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessor is deprecated but still the most portable way
      // to capture 16kHz mono frames. AudioWorklet would be the proper
      // upgrade — left as a TODO if CPU on the audio thread becomes a
      // bottleneck.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const queue = audioQueueRef.current;
        const merged = new Float32Array(queue.length + input.length);
        merged.set(queue);
        merged.set(input, queue.length);

        let offset = 0;
        while (offset + CHUNK_SAMPLES <= merged.length) {
          const chunk = merged.slice(offset, offset + CHUNK_SAMPLES);
          offset += CHUNK_SAMPLES;
          const m = modelRef.current;
          if (!m) break;
          void m
            .predict(chunk)
            .then((result: PredictionResult) => {
              const score = result[ENGINE_KEY] ?? 0;
              setLastScore(score);
              if (
                score >= thresholdRef.current &&
                Date.now() - lastFireRef.current > 2000
              ) {
                lastFireRef.current = Date.now();
                setState("activated");
                try {
                  onWakeRef.current();
                } catch {
                  // ignore callback errors so the loop keeps running
                }
              }
            })
            .catch(() => {
              // ignore individual frame failures
            });
        }
        audioQueueRef.current = merged.slice(offset);
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);

      setState("listening");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setState("error");
      stop();
    } finally {
      startingRef.current = false;
    }
  }, [stop]);

  useEffect(() => {
    if (!enabled || paused) {
      if (modelRef.current) stop();
      return;
    }
    void start();
  }, [enabled, paused, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    state,
    errorMessage,
    lastScore,
    /** True when the hook owns the mic and is actively running inference. */
    holding: state === "listening" || state === "activated" || state === "loading",
  };
}
