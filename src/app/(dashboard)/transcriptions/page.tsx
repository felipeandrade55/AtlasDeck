"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
  MessageSquare,
  ListTodo,
  Gavel,
  HelpCircle,
  Copy,
  Download,
  Pencil,
  Sparkles,
  Settings,
  Cpu,
  Cloud,
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

interface SuggestedTask {
  id: string;
  task: string;
  owner: string | null;
  due_date: string | null;
  priority: string | null;
  source_text: string | null;
  confidence: number;
  status: "pending" | "approved" | "rejected";
  reminder_id: string | null;
}

interface Decision {
  decision: string;
  rationale: string | null;
  owner: string | null;
}

interface Transcription {
  id: string;
  title: string;
  status: "recording" | "analyzing" | "analyzed" | "error";
  language: string;
  text: string;
  summary: string | null;
  key_points: string[];
  decisions: Decision[];
  topics: string[];
  open_questions: string[];
  duration_ms: number | null;
  memory_id: string | null;
  created_at: string;
  suggestions?: SuggestedEvent[];
  tasks?: SuggestedTask[];
}

export default function TranscriptionsPage() {
  return (
    <Suspense fallback={null}>
      <TranscriptionsPageInner />
    </Suspense>
  );
}

function TranscriptionsPageInner() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<Transcription[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep-link: /transcriptions?id=<id> opens that transcription directly
  // (used by the global ⌘K search to jump to a result).
  useEffect(() => {
    const id = searchParams.get("id");
    if (id) setSelectedId(id);
  }, [searchParams]);

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

  const [showConfig, setShowConfig] = useState(false);

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
      {showConfig && <TranscriptionConfigModal onClose={() => setShowConfig(false)} />}
      <div className="mb-6">
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 text-sm mb-4"
          style={{ color: "var(--text-secondary)" }}
        >
          <MessageSquare size={15} /> Ir para o Chat
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold mb-1" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
              Transcrições
            </h1>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Reuniões e conversas transcritas. Inicie uma nova pelo botão <strong>Transcrever</strong> no Chat.
            </p>
          </div>
          <button
            onClick={() => setShowConfig(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg shrink-0"
            style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            title="Configurar o provedor de IA da análise (OpenAI ou Ollama)"
          >
            <Settings size={15} /> Configurar IA
          </button>
        </div>
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [copied, setCopied] = useState(false);

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

  const startEditTitle = () => {
    if (!t) return;
    setTitleDraft(t.title);
    setEditingTitle(true);
  };

  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!title || !t || title === t.title) {
      setEditingTitle(false);
      return;
    }
    await fetch(`/api/transcribe/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setEditingTitle(false);
    await load();
  };

  const handleCopyMarkdown = async () => {
    if (!t) return;
    try {
      await navigator.clipboard.writeText(buildMarkdown(t));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked — fall back to download
      handleDownloadMarkdown();
    }
  };

  const handleDownloadMarkdown = () => {
    if (!t) return;
    const blob = new Blob([buildMarkdown(t)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(t.title)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading || !t) {
    return (
      <div className="p-8 flex items-center justify-center" style={{ color: "var(--text-muted)" }}>
        <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
      </div>
    );
  }

  const pending = (t.suggestions || []).filter((s) => s.status === "pending");
  const pendingTasks = (t.tasks || []).filter((s) => s.status === "pending");
  const isAnalyzing = t.status === "analyzing" || reanalyzing;
  // Re-analyze is available for any finished transcription with text — including
  // ones already "analyzed", so older transcriptions can be reprocessed to
  // extract the newer fields (decisions, topics, action items, open questions).
  const canReanalyze = !isAnalyzing && t.status !== "recording" && !!t.text.trim();

  return (
    <div className="p-4 md:p-8 space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm" style={{ color: "var(--text-secondary)" }}>
        <ChevronLeft size={16} /> Voltar
      </button>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="text-xl md:text-2xl font-bold rounded px-2 py-1 w-full"
                style={inputStyle}
              />
              <button onClick={saveTitle} className="p-1.5 rounded" style={{ color: "var(--success)" }}>
                <Check size={18} />
              </button>
              <button onClick={() => setEditingTitle(false)} className="p-1.5 rounded" style={{ color: "var(--text-muted)" }}>
                <X size={18} />
              </button>
            </div>
          ) : (
            <h1
              className="text-xl md:text-2xl font-bold flex items-center gap-2 group cursor-pointer"
              style={{ color: "var(--text-primary)" }}
              onClick={startEditTitle}
              title="Clique para renomear"
            >
              <span className="truncate">{t.title}</span>
              <Pencil size={15} className="opacity-0 group-hover:opacity-60 shrink-0" />
            </h1>
          )}
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {new Date(t.created_at).toLocaleString("pt-BR")} · {fmtDuration(t.duration_ms)} ·{" "}
            <StatusBadge status={t.status} inline />
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {t.status === "analyzed" && (
            <>
              <button
                onClick={handleCopyMarkdown}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg"
                style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                title="Copiar ata em Markdown"
              >
                {copied ? <Check size={15} style={{ color: "var(--success)" }} /> : <Copy size={15} />}
                {copied ? "Copiado" : "Copiar"}
              </button>
              <button
                onClick={handleDownloadMarkdown}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg"
                style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                title="Baixar ata em Markdown"
              >
                <Download size={15} /> .md
              </button>
            </>
          )}
          {canReanalyze && (
            <button
              onClick={handleReanalyze}
              disabled={reanalyzing}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg"
              style={{ color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}
              title="Reprocessa a transcrição e extrai tarefas, decisões, tópicos e perguntas em aberto"
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
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Use o botão “Re-analisar” para tentar novamente.</p>
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

      {/* Suggested tasks (action items) approval */}
      {pendingTasks.length > 0 && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "color-mix(in srgb, var(--success) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 25%, transparent)" }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            <ListTodo size={16} style={{ color: "var(--success)" }} />
            Tarefas sugeridas ({pendingTasks.length}) — aprove para criar um lembrete
          </h2>
          <div className="space-y-3">
            {pendingTasks.map((s) => (
              <TaskSuggestionCard key={s.id} s={s} transcriptionId={id} onResolved={load} />
            ))}
          </div>
        </div>
      )}

      {/* Summary + key points + topics */}
      {(t.summary || t.key_points.length > 0 || t.topics.length > 0) && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          {t.summary && (
            <>
              <h2 className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Resumo</h2>
              <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>{t.summary}</p>
            </>
          )}
          {t.topics.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {t.topics.map((topic, i) => (
                <span
                  key={i}
                  className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                  style={{ color: "var(--accent)", backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
                >
                  {topic}
                </span>
              ))}
            </div>
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

      {/* Decisions */}
      {t.decisions.length > 0 && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            <Gavel size={16} style={{ color: "var(--accent)" }} /> Decisões tomadas
          </h2>
          <div className="space-y-2.5">
            {t.decisions.map((d, i) => (
              <div key={i} className="text-sm">
                <p style={{ color: "var(--text-primary)", fontWeight: 500 }}>{d.decision}</p>
                {(d.rationale || d.owner) && (
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {d.rationale}
                    {d.rationale && d.owner ? " · " : ""}
                    {d.owner && <>Responsável: {d.owner}</>}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open questions */}
      {t.open_questions.length > 0 && (
        <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            <HelpCircle size={16} style={{ color: "var(--warning)" }} /> Perguntas em aberto
          </h2>
          <ul className="list-disc pl-5 space-y-0.5">
            {t.open_questions.map((q, i) => (
              <li key={i} className="text-sm" style={{ color: "var(--text-secondary)" }}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Q&A */}
      {t.status === "analyzed" && <QnaBox transcriptionId={id} />}

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

function TaskSuggestionCard({
  s,
  transcriptionId,
  onResolved,
}: {
  s: SuggestedTask;
  transcriptionId: string;
  onResolved: () => void;
}) {
  const [task, setTask] = useState(s.task);
  const [owner, setOwner] = useState(s.owner || "");
  const [when, setWhen] = useState(isoToLocalInput(s.due_date));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setError(null);
    setBusy(true);
    try {
      const dueIso = when ? new Date(when).toISOString() : null;
      const res = await fetch(`/api/transcribe/${transcriptionId}/tasks/${s.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, owner: owner || null, due_at: dueIso }),
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
      await fetch(`/api/transcribe/${transcriptionId}/tasks/${s.id}/reject`, { method: "POST" });
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg p-3" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex flex-col gap-2">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          className="text-sm font-medium rounded px-2 py-1.5 w-full"
          style={inputStyle}
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="Responsável (opcional)"
            className="text-sm rounded px-2 py-1.5 flex-1 min-w-[140px]"
            style={inputStyle}
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="text-sm rounded px-2 py-1.5"
            style={inputStyle}
          />
        </div>
        {s.source_text && (
          <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>“{s.source_text}”</p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[11px] flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
            confiança {Math.round(s.confidence * 100)}%
            {s.priority && <PriorityBadge priority={s.priority} />}
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

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    alta: "var(--error)",
    media: "var(--warning)",
    baixa: "var(--text-muted)",
  };
  const color = map[priority] || "var(--text-muted)";
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {priority}
    </span>
  );
}

function QnaBox({ transcriptionId }: { transcriptionId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch(`/api/transcribe/${transcriptionId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Falha ao responder");
      setAnswer(typeof data.answer === "string" ? data.answer : "(sem resposta)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao responder");
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <h2 className="flex items-center gap-2 text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
        <Sparkles size={16} style={{ color: "var(--accent)" }} /> Perguntar à IA sobre esta reunião
      </h2>
      <div className="flex flex-col gap-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
          }}
          placeholder="Ex: O que ficou combinado sobre o orçamento? Quem ficou responsável por enviar a proposta?"
          rows={2}
          className="text-sm rounded px-2 py-1.5 w-full resize-y"
          style={inputStyle}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Ctrl/⌘ + Enter para enviar</span>
          <button
            onClick={ask}
            disabled={asking || !question.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg"
            style={{ backgroundColor: "var(--accent)", color: "white", border: "none", opacity: asking || !question.trim() ? 0.6 : 1 }}
          >
            {asking ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Perguntar
          </button>
        </div>
        {error && <p className="text-xs" style={{ color: "var(--error)" }}>{error}</p>}
        {answer && (
          <div className="rounded-lg p-3 text-sm whitespace-pre-wrap" style={{ backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)", color: "var(--text-secondary)", border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)" }}>
            {answer}
          </div>
        )}
      </div>
    </div>
  );
}

interface OllamaModelInfo {
  name: string;
  size: number;
}

interface ConfigState {
  provider: "openai" | "ollama";
  ollama_model: string;
  openai_configured: boolean;
  ollama: { installed: boolean; running: boolean; models: OllamaModelInfo[] };
}

function TranscriptionConfigModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ConfigState | null>(null);
  const [provider, setProvider] = useState<"openai" | "ollama">("openai");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/transcribe/config");
        if (res.ok) {
          const data: ConfigState = await res.json();
          setCfg(data);
          setProvider(data.provider);
          // Default the model selection to the saved one, or the first installed.
          setModel(data.ollama_model || data.ollama.models[0]?.name || "");
        }
      } catch {
        setError("Falha ao carregar configuração.");
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: { provider: string; ollama_model?: string } = { provider };
      if (provider === "ollama") body.ollama_model = model;
      const res = await fetch("/api/transcribe/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Falha ao salvar");
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const ollamaReady = !!cfg?.ollama.running && cfg.ollama.models.length > 0;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ width: "100%", maxWidth: 520, backgroundColor: "var(--card)", border: "1px solid var(--border)", borderRadius: "0.75rem", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.875rem 1.25rem", borderBottom: "1px solid var(--border)" }}>
          <h2 className="flex items-center gap-2 text-base font-bold" style={{ color: "var(--text-primary)" }}>
            <Settings size={18} style={{ color: "var(--accent)" }} /> IA da análise de transcrições
          </h2>
          <button onClick={onClose} style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "1.25rem" }}>
          {!cfg ? (
            <div className="flex items-center justify-center py-8" style={{ color: "var(--text-muted)" }}>
              <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Escolha quem analisa as transcrições (resumo, tarefas, decisões, tópicos…).
              </p>

              {/* OpenAI option */}
              <button
                onClick={() => setProvider("openai")}
                className="w-full text-left rounded-lg p-3 flex items-start gap-3"
                style={{
                  border: `1px solid ${provider === "openai" ? "var(--accent)" : "var(--border)"}`,
                  backgroundColor: provider === "openai" ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                }}
              >
                <Cloud size={18} style={{ color: "var(--accent)", marginTop: 2 }} />
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                    OpenAI (gpt-4o-mini) <span className="text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>· nuvem, pago</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    Melhor qualidade e consistência de JSON. {cfg.openai_configured ? "Chave configurada." : "⚠️ OPENAI_API_KEY não configurada."}
                  </p>
                </div>
                {provider === "openai" && <Check size={16} style={{ color: "var(--accent)" }} />}
              </button>

              {/* Ollama option */}
              <button
                onClick={() => setProvider("ollama")}
                className="w-full text-left rounded-lg p-3 flex items-start gap-3"
                style={{
                  border: `1px solid ${provider === "ollama" ? "var(--accent)" : "var(--border)"}`,
                  backgroundColor: provider === "ollama" ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                }}
              >
                <Cpu size={18} style={{ color: "var(--success)", marginTop: 2 }} />
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                    Ollama <span className="text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>· local, grátis e privado</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {cfg.ollama.running
                      ? `Rodando · ${cfg.ollama.models.length} modelo(s) instalado(s).`
                      : cfg.ollama.installed
                      ? "Instalado, mas não está rodando."
                      : "Não detectado neste servidor."}
                  </p>
                </div>
                {provider === "ollama" && <Check size={16} style={{ color: "var(--accent)" }} />}
              </button>

              {/* Ollama model picker */}
              {provider === "ollama" && (
                <div className="pl-1">
                  <label className="text-xs font-semibold block mb-1" style={{ color: "var(--text-secondary)" }}>
                    Modelo local
                  </label>
                  {ollamaReady ? (
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full text-sm rounded px-2 py-2"
                      style={inputStyle}
                    >
                      {cfg.ollama.models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name} ({fmtBytes(m.size)})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-xs rounded-lg p-2" style={{ color: "var(--warning)", backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
                      Nenhum modelo disponível. Instale modelos em Configurações → Memória → Ollama (ex.: <code>gemma2:9b</code>, <code>qwen2.5:7b</code>).
                    </p>
                  )}
                </div>
              )}

              {error && <p className="text-xs" style={{ color: "var(--error)" }}>{error}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", padding: "0.875rem 1.25rem", borderTop: "1px solid var(--border)" }}>
          <button onClick={onClose} className="px-3 py-2 text-sm rounded-lg" style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving || !cfg || (provider === "ollama" && !model)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg font-semibold"
            style={{ backgroundColor: "var(--accent)", color: "white", border: "none", opacity: saving || !cfg || (provider === "ollama" && !model) ? 0.6 : 1 }}
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtBytes(bytes: number): string {
  if (!bytes) return "?";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
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

/** Format an ISO date for display in the Markdown export (or "—"). */
function fmtDateLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR");
}

/** Build a Markdown meeting recap from a transcription. */
function buildMarkdown(t: Transcription): string {
  const lines: string[] = [];
  lines.push(`# ${t.title}`, "");
  lines.push(`**Data:** ${new Date(t.created_at).toLocaleString("pt-BR")} · **Duração:** ${fmtDuration(t.duration_ms)}`, "");

  if (t.topics.length) {
    lines.push(`**Tópicos:** ${t.topics.join(", ")}`, "");
  }
  if (t.summary) {
    lines.push("## Resumo", "", t.summary, "");
  }
  if (t.key_points.length) {
    lines.push("## Pontos principais", "");
    t.key_points.forEach((k) => lines.push(`- ${k}`));
    lines.push("");
  }
  if (t.decisions.length) {
    lines.push("## Decisões", "");
    t.decisions.forEach((d) => {
      const extra = [d.rationale, d.owner ? `Responsável: ${d.owner}` : null].filter(Boolean).join(" — ");
      lines.push(`- ${d.decision}${extra ? ` (${extra})` : ""}`);
    });
    lines.push("");
  }
  if (t.tasks && t.tasks.length) {
    lines.push("## Tarefas (action items)", "");
    t.tasks.forEach((task) => {
      const meta = [
        task.owner ? `@${task.owner}` : null,
        task.due_date ? `prazo ${fmtDateLabel(task.due_date)}` : null,
        task.priority ? `prioridade ${task.priority}` : null,
      ].filter(Boolean).join(" · ");
      lines.push(`- [ ] ${task.task}${meta ? ` — ${meta}` : ""}`);
    });
    lines.push("");
  }
  if (t.open_questions.length) {
    lines.push("## Perguntas em aberto", "");
    t.open_questions.forEach((q) => lines.push(`- ${q}`));
    lines.push("");
  }
  lines.push("## Transcrição completa", "", t.text || "(vazio)", "");
  return lines.join("\n");
}

/** Filesystem-safe slug for the downloaded .md filename. */
function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "transcricao"
  );
}
