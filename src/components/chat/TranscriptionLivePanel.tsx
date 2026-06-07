"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Square, Loader2, Mic, AlertCircle, CheckCircle2 } from "lucide-react";

/**
 * Live transcription overlay. Records the mic in ~45s cycles (each cycle
 * produces a complete, independently-decodable webm file), uploads each to
 * the server which transcribes via OpenAI and appends the text. On stop it
 * finalizes the session (analysis → suggested events + memory).
 */
const CHUNK_MS = 45_000;

type Phase = "starting" | "recording" | "finalizing" | "done" | "error";

export function TranscriptionLivePanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [chunks, setChunks] = useState<string[]>([]); // indexed by seq
  const [elapsed, setElapsed] = useState(0);
  const [suggestionsCreated, setSuggestionsCreated] = useState<number | null>(null);

  const idRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stoppedRef = useRef(false);
  const seqRef = useRef(0);
  const mimeRef = useRef<string>("audio/webm");
  const startedAtRef = useRef<number>(0);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setChunkText = useCallback((seq: number, text: string) => {
    setChunks((prev) => {
      const next = prev.slice();
      next[seq] = text;
      return next;
    });
  }, []);

  const uploadChunk = useCallback(async (blob: Blob, seq: number) => {
    const id = idRef.current;
    if (!id || blob.size === 0) return;
    try {
      const form = new FormData();
      form.append("audio", blob, `chunk-${seq}.webm`);
      form.append("seq", String(seq));
      const res = await fetch(`/api/transcribe/${id}/chunk`, { method: "POST", body: form });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.text === "string") setChunkText(seq, data.text);
      } else if (res.status === 402) {
        // Quota exceeded — stop recording and surface the error
        const data = await res.json().catch(() => ({}));
        stoppedRef.current = true;
        if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
        try { if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop(); } catch {}
        streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        setError(data.error || "Cota da OpenAI esgotada. Adicione créditos em platform.openai.com/settings/billing");
        setPhase("error");
      }
    } catch {
      // a failed chunk just leaves a gap; recording continues
    }
  }, [setChunkText]);

  const startCycle = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppedRef.current) return;
    const rec = new MediaRecorder(stream, { mimeType: mimeRef.current });
    const parts: BlobPart[] = [];
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    rec.onstop = () => {
      const seq = seqRef.current++;
      const blob = new Blob(parts, { type: mimeRef.current });
      void uploadChunk(blob, seq);
      if (!stoppedRef.current) startCycle();
    };
    rec.start();
    cycleTimerRef.current = setTimeout(() => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {}
    }, CHUNK_MS);
  }, [uploadChunk]);

  // Boot: create session + open mic + start recording.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || "Falha ao iniciar transcrição");
        }
        const session = await res.json();
        if (cancelled) return;
        idRef.current = session.id;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        mimeRef.current = pickMime();
        startedAtRef.current = Date.now();
        setPhase("recording");
        startCycle();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Falha ao acessar o microfone");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const cleanupMedia = useCallback(() => {
    stoppedRef.current = true;
    if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {}
    });
  }, []);

  const handleStop = useCallback(async () => {
    if (stoppedRef.current) return;
    cleanupMedia();
    setPhase("finalizing");
    const id = idRef.current;
    if (!id) {
      setPhase("done");
      return;
    }
    // Give the last chunk a moment to upload before finalizing.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`/api/transcribe/${id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duration_ms: Date.now() - startedAtRef.current }),
      });
      const data = await res.json().catch(() => ({}));
      setSuggestionsCreated(typeof data.suggestions_created === "number" ? data.suggestions_created : 0);
    } catch {
      setSuggestionsCreated(0);
    }
    setPhase("done");
    if (idRef.current) onSaved?.(idRef.current);
  }, [cleanupMedia, onSaved]);

  // Stop media if the panel unmounts while recording.
  useEffect(() => () => cleanupMedia(), [cleanupMedia]);

  const liveText = chunks.filter(Boolean).join(" ");

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", padding: "1rem" }}
      onClick={phase === "done" || phase === "error" ? onClose : undefined}
    >
      <div
        style={{ width: "100%", maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column", backgroundColor: "var(--card)", border: "1px solid var(--border)", borderRadius: "0.75rem", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.875rem 1.25rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            {phase === "recording" ? (
              <span style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "var(--error)", animation: "pulse 1.2s infinite" }} />
            ) : (
              <Mic size={18} style={{ color: "var(--accent)" }} />
            )}
            <h2 style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)" }}>
              {phase === "recording"
                ? `Transcrevendo · ${fmtTime(elapsed)}`
                : phase === "starting"
                ? "Iniciando…"
                : phase === "finalizing"
                ? "Analisando…"
                : phase === "done"
                ? "Transcrição concluída"
                : "Erro"}
            </h2>
          </div>
          <button onClick={phase === "recording" || phase === "finalizing" ? handleStop : onClose} style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "1.25rem", overflowY: "auto", flex: 1 }}>
          {phase === "error" ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--error)" }}>
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          ) : phase === "done" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", color: "var(--text-secondary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--success)" }}>
                <CheckCircle2 size={18} />
                <span style={{ fontWeight: 600 }}>Transcrição salva e analisada.</span>
              </div>
              {suggestionsCreated != null && suggestionsCreated > 0 && (
                <p style={{ fontSize: "0.875rem" }}>
                  {suggestionsCreated} compromisso(s) sugerido(s) aguardando sua aprovação.
                </p>
              )}
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{liveText || "(sem texto)"}</p>
            </div>
          ) : (
            <>
              {liveText ? (
                <p style={{ fontSize: "0.9rem", lineHeight: 1.6, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
                  {liveText}
                  {phase === "recording" && <span style={{ opacity: 0.5 }}> ▍</span>}
                </p>
              ) : (
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  {phase === "finalizing"
                    ? "Processando a transcrição e extraindo compromissos…"
                    : "Fale à vontade. O texto aparece a cada bloco (~45s)."}
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", padding: "0.875rem 1.25rem", borderTop: "1px solid var(--border)" }}>
          {phase === "recording" && (
            <button
              onClick={handleStop}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 1rem", borderRadius: "0.5rem", backgroundColor: "var(--error)", color: "white", border: "none", cursor: "pointer", fontWeight: 600 }}
            >
              <Square size={16} /> Parar e analisar
            </button>
          )}
          {(phase === "starting" || phase === "finalizing") && (
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-muted)" }}>
              <Loader2 size={16} className="animate-spin" />
              {phase === "starting" ? "Abrindo microfone…" : "Analisando com a IA…"}
            </span>
          )}
          {(phase === "done" || phase === "error") && (
            <button onClick={onClose} style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer", fontWeight: 600 }}>
              Fechar
            </button>
          )}
        </div>
      </div>
      <style jsx global>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  );
}

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return "audio/webm";
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
