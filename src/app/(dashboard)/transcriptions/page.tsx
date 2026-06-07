"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Trash2,
  Calendar,
  Check,
  X,
  ChevronLeft,
  Brain,
  AlertCircle,
  Mic,
  RefreshCw,
} from "lucide-react";

interface SuggestedEvent {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  source_text: string | null;
  confidence: number;
  status: "pending" | "approved" | "rejected";
  event_id: string | null;
}

interface Transcription {
  id: string;
  title: string;
  status: "recording" | "analyzing" | "analyzed" | "error";
  language: string;
  text: string;
  summary: string | null;
  key_points: string[];
  duration_ms: number | null;
  memory_id: string | null;
  created_at: string;
  suggestions?: SuggestedEvent[];
}

export default function TranscriptionsPage() {
  const [items, setItems] = useState<Transcription[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch("/api/transcribe");
      if (res.ok) {
        const data = await res.json();
        setItems(Array.isArray(data.items) ? data.items : []);
        setConfigured(!!data.configured);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, 15000);
    return () => clearInterval(t);
  }, [fetchList]);

  if (selectedId) {
    return (
      <TranscriptionDetail
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
          fetchList();
        }}
      />
    );
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold mb-1" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
          Transcrições
        </h1>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Reuniões e conversas transcritas. Inicie uma nova pelo botão <strong>Transcrever</strong> no Chat.
        </p>
      </div>

      {!configured && (
        <div className="mb-4 flex items-center gap-2 p-3 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, var(--warning) 12%, transparent)", color: "var(--warning)" }}>
          <AlertCircle size={18} />
          <span className="text-sm">Defina <code>OPENAI_API_KEY</code> no servidor para habilitar a transcrição.</span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)", border: "1px dashed var(--border)" }}>
          <Mic className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
          <h3 className="text-base font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Nenhuma transcrição ainda</h3>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Vá ao Chat e clique em “Transcrever” para gravar a primeira.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {items.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className="text-left rounded-xl p-4"
              style={{ backgroundColor: "color-mix(in srgb, var(--card) 60%, transparent)", border: "1px solid var(--border)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold truncate" style={{ color: "var(--text-primary)" }}>{t.title}</h3>
                <StatusBadge status={t.status} />
              </div>
              <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
                {new Date(t.created_at).toLocaleString("pt-BR")} · {fmtDuration(t.duration_ms)}
              </p>
              <p className="text-sm line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                {t.summary || (t.text ? t.text.slice(0, 140) + "…" : "—")}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [t, setT] = useState<Transcription | null>(null);
  const [loading, setLoading] = useState(true);
  const [reanalyzing, setReanalyzing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/transcribe/${id}`);
      if (res.ok) setT(await res.json());
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 4s while analyzing
  useEffect(() => {
    if (!t || (t.status !== "analyzing" && !reanalyzing)) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [t, reanalyzing, load]);

  const handleDelete = async () => {
    if (!confirm("Excluir esta transcrição? As sugestões pendentes também somem.")) return;
    await fetch(`/api/transcribe/${id}`, { method: "DELETE" });
    onBack();
  };

  const handleReanalyze = async () => {
    setReanalyzing(true);
    try {
      await fetch(`/api/transcribe/${id}/reanalyze`, { method: "POST" });
      await load();
    } finally {
      setReanalyzing(false);
    }
  };

  if (loading || !t) {
    return (
      <div className="p-8 flex items-center justify-center" style={{ color: "var(--text-muted)" }}>
        <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
      </div>
    );
  }

  const pending = (t.suggestions || []).filter((s) => s.status === "pending");
  const isAnalyzing = t.status === "analyzing" || reanalyzing;
  const canReanalyze = t.status === "analyzing" || t.status === "error";

  return (
    <div className="p-4 md:p-8 space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm" style={{ color: "var(--text-secondary)" }}>
        <ChevronLeft size={16} /> Voltar
      </button>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold" style={{ color: "var(--text-primary)" }}>{t.title}</h1>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {new Date(t.created_at).toLocaleString("pt-BR")} · {fmtDuration(t.duration_ms)} ·{" "}
            <StatusBadge status={t.status} inline />
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canReanalyze && (
            <button
              onClick={handleReanalyze}
              disabled={reanalyzing}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg"
              style={{ color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}
            >
              {reanalyzing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Re-analisar
            </button>
          )}
          <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)" }}>
            <Trash2 size={15} /> Excluir
          </button>
        </div>
      </div>

      {/* Analyzing banner */}
      {isAnalyzing && (
        <div className="flex items-center gap-3 rounded-xl p-4" style={{ backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
          <Loader2 size={16} className="animate-spin shrink-0" style={{ color: "var(--warning)" }} />
          <p className="text-sm" style={{ color: "var(--warning)" }}>
            Analisando com IA… isso pode levar alguns segundos.
          </p>
        </div>
      )}

      {/* Error banner */}
      {t.status === "error" && !reanalyzing && (
        <div className="flex items-start gap-3 rounded-xl p-4" style={{ backgroundColor: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)" }}>
          <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: "var(--error)" }} />
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--error)" }}>Falha na análise</p>
            {t.summary && <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{t.summary}</p>}
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Use o botão "Re-analisar" para tentar novamente.</p>
          </div>
        </div>
      )}

      {/* Suggested events approval */}
      {pending.length > 0 && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)" }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            <Calendar size={16} style={{ color: "var(--accent)" }} />
            Compromissos sugeridos ({pending.length}) — aprove para adicionar à agenda
          </h2>
          <div className="space-y-3">
            {pending.map((s) => (
              <SuggestionCard key={s.id} s={s} onResolved={load} />
            ))}
          </div>
        </div>
      )}

      {/* Summary + key points */}
      {(t.summary || t.key_points.length > 0) && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          {t.summary && (
            <>
              <h2 className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Resumo</h2>
              <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>{t.summary}</p>
            </>
          )}
          {t.key_points.length > 0 && (
            <>
              <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Pontos principais</h3>
              <ul className="list-disc pl-5 space-y-0.5">
                {t.key_points.map((k, i) => (
                  <li key={i} className="text-sm" style={{ color: "var(--text-secondary)" }}>{k}</li>
                ))}
              </ul>
            </>
          )}
          {t.memory_id && (
            <p className="flex items-center gap-1.5 text-xs mt-3" style={{ color: "var(--text-muted)" }}>
              <Brain size={13} /> Salvo na memória — o Jarvis pode lembrar disso.
            </p>
          )}
        </div>
      )}

      {/* Full transcript */}
      <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>Transcrição completa</h2>
        <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {t.text || "(vazio)"}
        </p>
      </div>
    </div>
  );
}

function SuggestionCard({ s, onResolved }: { s: SuggestedEvent; onResolved: () => void }) {
  const [title, setTitle] = useState(s.title);
  const [when, setWhen] = useState(isoToLocalInput(s.start_at));
  const [location, setLocation] = useState(s.location || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setError(null);
    if (!when) {
      setError("Defina a data/hora.");
      return;
    }
    setBusy(true);
    try {
      const startIso = new Date(when).toISOString();
      const res = await fetch(`/api/calendar/suggested-events/${s.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, start_at: startIso, location: location || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Falha ao aprovar");
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao aprovar");
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await fetch(`/api/calendar/suggested-events/${s.id}/reject`, { method: "POST" });
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg p-3" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex flex-col gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-sm font-medium rounded px-2 py-1.5 w-full"
          style={inputStyle}
        />
        <div className="flex flex-wrap gap-2">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="text-sm rounded px-2 py-1.5"
            style={inputStyle}
          />
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Local / link (opcional)"
            className="text-sm rounded px-2 py-1.5 flex-1 min-w-[140px]"
            style={inputStyle}
          />
        </div>
        {s.source_text && (
          <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>“{s.source_text}”</p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            confiança {Math.round(s.confidence * 100)}%
          </span>
          <div className="flex items-center gap-2">
            <button onClick={reject} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg" style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
              <X size={14} /> Rejeitar
            </button>
            <button onClick={approve} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg" style={{ backgroundColor: "var(--success)", color: "white", border: "none" }}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Aprovar
            </button>
          </div>
        </div>
        {error && <p className="text-xs" style={{ color: "var(--error)" }}>{error}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ status, inline }: { status: Transcription["status"]; inline?: boolean }) {
  const map: Record<Transcription["status"], { label: string; color: string }> = {
    recording: { label: "Gravando", color: "var(--error)" },
    analyzing: { label: "Analisando", color: "var(--warning)" },
    analyzed: { label: "Pronto", color: "var(--success)" },
    error: { label: "Erro", color: "var(--error)" },
  };
  const s = map[status];
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
      style={{
        color: s.color,
        backgroundColor: `color-mix(in srgb, ${s.color} 18%, transparent)`,
        display: inline ? "inline-block" : undefined,
      }}
    >
      {s.label}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--card-elevated)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  outline: "none",
};

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, "0")}`;
}

/** ISO → "YYYY-MM-DDTHH:mm" in local time for datetime-local inputs. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
