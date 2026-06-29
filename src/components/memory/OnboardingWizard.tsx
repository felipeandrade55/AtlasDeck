"use client";

/**
 * Conversational wizard that walks the user through a short interview
 * in PT-BR, then asks the configured LLM (Ollama preferred, OpenClaw
 * fallback) to synthesize IDENTITY.md / SOUL.md / USER.md from the
 * answers. The user reviews + edits before saving; existing files are
 * backed up automatically by the /save endpoint.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Cpu,
  Edit3,
  HardDrive,
  Info,
  Loader2,
  MessageCircle,
  PlayCircle,
  RotateCcw,
  Save,
  Sparkles,
  Timer,
} from "lucide-react";
import { useToast } from "@/components/Toast";

interface Turn {
  question: string;
  answer: string;
}

interface NextResponse {
  complete: boolean;
  next_question?: string;
  covered?: string[];
  summary?: string;
  provider?: string;
  model?: string;
  hint?: string;
  error?: string;
}

interface GenerateResponse {
  files?: {
    "IDENTITY.md": string;
    "SOUL.md": string;
    "USER.md": string;
  };
  provider?: string;
  model?: string;
  fallback?: boolean;
  error?: string;
}

// Mirror of the server's static question plan. Used as a client-side
// safety net so a failed/slow /next call advances to a fresh question
// instead of leaving the previous one on screen (which read as a repeat).
const STATIC_QUESTIONS = [
  "Pra começar, qual é o seu nome e o que você faz no dia a dia?",
  "Qual é a sua stack técnica? Quais linguagens, frameworks e ferramentas você usa no dia a dia?",
  "Como você prefere se comunicar com o agente? Respostas curtas ou detalhadas? Tom formal ou informal?",
  "Pensa num nome e numa 'vibe' pro seu agente — como você quer que ele seja: direto, analítico, criativo? Tem algum limite que ele não deve cruzar?",
  "Qual é o seu projeto principal agora? O que você está construindo e qual é o foco atual?",
];

const normalizeQ = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

function nextStaticQuestion(history: Turn[]): string | null {
  const asked = new Set(history.map((h) => normalizeQ(h.question)));
  return STATIC_QUESTIONS.find((q) => !asked.has(normalizeQ(q))) ?? null;
}

interface OllamaStatusPayload {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: Array<{ name: string }>;
}

interface LLMChoicePayload {
  choice_made: boolean;
  extractor_provider: "ollama" | "openclaw" | "heuristic";
  ollama_model: string;
  ollama: {
    installed: boolean;
    running: boolean;
    has_recommended_model: boolean;
    models_count: number;
  };
  openclaw: {
    configured: boolean;
    bin: string;
    bin_exists: boolean;
  };
}

interface Props {
  workspace: string;
  onSwitchToFilesTab?: () => void;
}

type Phase = "llm_choice" | "intro" | "interview" | "generating" | "review" | "saved";

const FILE_NAMES = ["IDENTITY.md", "SOUL.md", "USER.md"] as const;
type FileName = (typeof FILE_NAMES)[number];

interface PersistedState {
  workspace: string;
  phase: Phase;
  history: Turn[];
  summary: string | null;
  drafts: Record<FileName, string>;
  updatedAt: string;
}

const STORAGE_KEY = "atlasdeck:memory-wizard:v1";

function loadPersisted(workspace: string): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed?.workspace !== workspace) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(state: PersistedState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / privacy mode — silently ignore
  }
}

function clearPersisted() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function OnboardingWizard({ workspace, onSwitchToFilesTab }: Props) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("intro");
  const [history, setHistory] = useState<Turn[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [askingNext, setAskingNext] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [providerInfo, setProviderInfo] = useState<{ provider: string; model: string } | null>(null);
  const [ollama, setOllama] = useState<OllamaStatusPayload | null>(null);

  const [drafts, setDrafts] = useState<Record<FileName, string>>({
    "IDENTITY.md": "",
    "SOUL.md": "",
    "USER.md": "",
  });
  const [activeDraft, setActiveDraft] = useState<FileName>("IDENTITY.md");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);

  const [llmChoice, setLlmChoice] = useState<LLMChoicePayload | null>(null);
  const [savingChoice, setSavingChoice] = useState<null | "ollama" | "openclaw" | "later">(null);

  const answerRef = useRef<HTMLTextAreaElement | null>(null);

  // Fetch Ollama status + LLM choice state in parallel. The choice
  // endpoint is the source of truth for "should we ask?" — Ollama
  // status is still fetched for the recommendation card inside the
  // choice and intro phases.
  useEffect(() => {
    let aborted = false;
    Promise.all([
      fetch("/api/memory/ollama/status").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/memory/llm-choice").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([statusData, choiceData]) => {
        if (aborted) return;
        if (statusData) setOllama(statusData);
        if (choiceData) setLlmChoice(choiceData);
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, []);

  // Restore persisted state when workspace changes
  useEffect(() => {
    const persisted = loadPersisted(workspace);
    if (persisted) {
      setPhase(persisted.phase);
      setHistory(persisted.history);
      setSummary(persisted.summary);
      setDrafts(persisted.drafts);
      setRestored(true);
      return;
    }
    setPhase("intro");
    setHistory([]);
    setSummary(null);
    setDrafts({ "IDENTITY.md": "", "SOUL.md": "", "USER.md": "" });
    setCurrentQuestion(null);
    setCurrentAnswer("");
    setRestored(false);
  }, [workspace]);

  // Once we know the LLM-choice state, hoist the user into the choice
  // phase if they haven't picked yet AND they're on a fresh intro
  // (no in-progress interview). Skips entirely for users who already
  // chose, so existing installs don't get nagged.
  useEffect(() => {
    if (!llmChoice) return;
    if (llmChoice.choice_made) return;
    if (history.length > 0) return;
    setPhase((current) => (current === "intro" ? "llm_choice" : current));
  }, [llmChoice, history.length]);

  // Persist state whenever something meaningful changes (but not transient input)
  useEffect(() => {
    if (phase === "intro" && history.length === 0 && summary === null) {
      // Nothing to persist for a fresh intro state
      return;
    }
    savePersisted({
      workspace,
      phase,
      history,
      summary,
      drafts,
      updatedAt: new Date().toISOString(),
    });
  }, [workspace, phase, history, summary, drafts]);

  const fetchNext = useCallback(
    async (workingHistory: Turn[]) => {
      try {
        setAskingNext(true);
        const res = await fetch("/api/memory/wizard/next", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history: workingHistory }),
        });
        const data = (await res.json()) as NextResponse;
        if (!res.ok) {
          throw new Error(data?.hint || data?.error || "Falha");
        }
        if (data.provider && data.model) {
          setProviderInfo({ provider: data.provider, model: data.model });
        }
        if (data.complete) {
          setCurrentQuestion(null);
          setSummary(data.summary || "Tenho contexto suficiente.");
          return;
        }
        // Guard: if the server somehow returns an empty or already-asked
        // question, fall back to the next unused static one so the user
        // never sees the same question twice.
        const proposed = data.next_question?.trim();
        const asked = new Set(workingHistory.map((h) => normalizeQ(h.question)));
        if (proposed && !asked.has(normalizeQ(proposed))) {
          setCurrentQuestion(proposed);
        } else {
          const fallback = nextStaticQuestion(workingHistory);
          if (fallback) {
            setCurrentQuestion(fallback);
          } else {
            setCurrentQuestion(null);
            setSummary("Tenho contexto suficiente.");
          }
        }
      } catch {
        // Network/route error — don't strand the previous question on
        // screen (that looked like a repeat). Advance to the next unused
        // static question, or wrap up if all topics are covered.
        const fallback = nextStaticQuestion(workingHistory);
        if (fallback) {
          setCurrentQuestion(fallback);
          setProviderInfo({ provider: "bootstrap", model: "static" });
        } else {
          setCurrentQuestion(null);
          setSummary("Tenho contexto suficiente.");
        }
      } finally {
        setAskingNext(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (currentQuestion) {
      answerRef.current?.focus();
    }
  }, [currentQuestion]);

  const startInterview = useCallback(async () => {
    setPhase("interview");
    if (history.length === 0) {
      await fetchNext([]);
    }
  }, [fetchNext, history.length]);

  const chooseLLM = useCallback(
    async (choice: "ollama" | "openclaw" | "later") => {
      try {
        setSavingChoice(choice);
        const res = await fetch("/api/memory/llm-choice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choice }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Falha ao salvar escolha");
        // Refresh state from server so the UI reflects the new provider
        const refreshed = await fetch("/api/memory/llm-choice")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (refreshed) setLlmChoice(refreshed);
        if (choice === "ollama") {
          toast.success("Tudo certo — usando Ollama local (zero custo).");
        } else if (choice === "openclaw") {
          toast.success("Tudo certo — usando OpenClaw como extrator principal.");
        } else {
          toast.info("Você pode escolher depois em Memória → Configurações.");
        }
        setPhase("intro");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha");
      } finally {
        setSavingChoice(null);
      }
    },
    [toast],
  );

  const submitAnswer = useCallback(async () => {
    if (!currentQuestion || !currentAnswer.trim()) return;
    const turn: Turn = {
      question: currentQuestion,
      answer: currentAnswer.trim(),
    };
    const next = [...history, turn];
    setHistory(next);
    setCurrentAnswer("");
    await fetchNext(next);
  }, [currentQuestion, currentAnswer, history, fetchNext]);

  const skipQuestion = useCallback(async () => {
    if (!currentQuestion) return;
    const next: Turn[] = [
      ...history,
      { question: currentQuestion, answer: "(usuário preferiu pular)" },
    ];
    setHistory(next);
    setCurrentAnswer("");
    await fetchNext(next);
  }, [currentQuestion, history, fetchNext]);

  const reset = useCallback(() => {
    if (history.length > 0 && !window.confirm("Reiniciar a entrevista? Você perde as respostas atuais.")) {
      return;
    }
    clearPersisted();
    setHistory([]);
    setSummary(null);
    setCurrentQuestion(null);
    setCurrentAnswer("");
    setDrafts({ "IDENTITY.md": "", "SOUL.md": "", "USER.md": "" });
    setPhase("intro");
    setRestored(false);
  }, [history.length]);

  const generate = useCallback(async () => {
    try {
      setGenerating(true);
      setPhase("generating");
      const res = await fetch("/api/memory/wizard/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history }),
      });
      const data = (await res.json()) as GenerateResponse;
      if (!res.ok || !data.files) {
        throw new Error(data?.error || "Falha na geração");
      }
      setDrafts(data.files);
      if (data.provider && data.model) {
        setProviderInfo({ provider: data.provider, model: data.model });
      }
      if (data.fallback) {
        toast.info(
          "Nenhum LLM disponível — geramos um rascunho a partir das suas respostas. Revise, edite e salve (ou clique em Regerar quando tiver Ollama/OpenClaw ativo).",
        );
      }
      setPhase("review");
    } catch (err) {
      setPhase("interview");
      toast.error(err instanceof Error ? err.message : "Falha");
    } finally {
      setGenerating(false);
    }
  }, [history, toast]);

  const save = useCallback(async () => {
    try {
      setSaving(true);
      const res = await fetch("/api/memory/wizard/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, files: drafts }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Falha ao salvar");
      }
      toast.success(`Arquivos salvos em ${workspace}`);
      setPhase("saved");
      clearPersisted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    } finally {
      setSaving(false);
    }
  }, [workspace, drafts, toast]);

  const importNow = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, embed: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Falha");
      toast.success(`${data.imported ?? 0} memória(s) importada(s) e embedada(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  }, [workspace, toast]);

  const llmAvailable = ollama?.installed && ollama?.running;

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h3 style={sectionTitleStyle}>
          <Sparkles size={14} /> Wizard de identidade
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {providerInfo && (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              via {providerInfo.provider}:{providerInfo.model}
            </span>
          )}
          {(history.length > 0 || (phase !== "intro" && phase !== "llm_choice")) && (
            <button type="button" onClick={reset} style={ghostButtonStyle} title="Reiniciar entrevista">
              <RotateCcw size={12} /> Reiniciar
            </button>
          )}
        </div>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        Conversa rápida em português pra popular <code>IDENTITY.md</code>, <code>SOUL.md</code> e{" "}
        <code>USER.md</code> do workspace <strong>{workspace}</strong>.
      </p>

      {restored && phase !== "intro" && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            borderRadius: 6,
            background: "var(--bg)",
            border: "1px dashed var(--border)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          Continuação automática: você tinha uma entrevista em andamento neste workspace.
        </div>
      )}

      {/* LLM CHOICE PHASE: shown only on a fresh install where the
          user hasn't picked a provider yet. Three buttons:
          Ollama / OpenClaw / decide later. */}
      {phase === "llm_choice" && llmChoice && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Info size={14} style={{ color: "var(--accent)" }} />
              <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                Como você quer rodar o agente?
              </strong>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              O AtlasDeck precisa de uma LLM pra <strong>extrair memórias</strong>{" "}
              das suas conversas e <strong>conduzir essa entrevista</strong>.
              Você pode usar uma LLM local (grátis, qualidade boa) ou uma LLM
              externa via OpenClaw (paga, qualidade maior). Dá pra trocar
              quando quiser em <strong>Memória → Configurações</strong>.
            </p>
          </div>

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {/* OLLAMA CARD */}
            <button
              type="button"
              onClick={() => chooseLLM("ollama")}
              disabled={savingChoice !== null}
              style={{
                ...choiceCardStyle,
                borderColor: llmChoice.ollama.running ? "var(--success, #32D74B)" : "var(--border)",
                opacity: savingChoice && savingChoice !== "ollama" ? 0.5 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <HardDrive size={16} style={{ color: "var(--success, #32D74B)" }} />
                <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Ollama local</strong>
                <span style={badgeStyle("var(--success, #32D74B)")}>Grátis</span>
              </div>
              <p style={choiceBodyStyle}>
                Roda um modelo open-source (Qwen 2.5 7B, ~5 GB disco, ~8 GB RAM)
                na sua própria máquina. Zero custo, sem chave de API, dados
                nunca saem daqui.
              </p>
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
                {llmChoice.ollama.running && llmChoice.ollama.has_recommended_model
                  ? "✅ Ollama rodando + modelo recomendado disponível"
                  : llmChoice.ollama.running
                  ? `⚠️ Rodando, mas sem ${llmChoice.ollama_model} — vamos baixar`
                  : llmChoice.ollama.installed
                  ? "⚠️ Instalado, mas parado — vamos te orientar"
                  : "⬇️ Não instalado — abrimos o guia depois de confirmar"}
              </div>
              {savingChoice === "ollama" && (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <Loader2 size={11} className="animate-spin" /> Salvando…
                </div>
              )}
            </button>

            {/* OPENCLAW CARD */}
            <button
              type="button"
              onClick={() => chooseLLM("openclaw")}
              disabled={savingChoice !== null}
              style={{
                ...choiceCardStyle,
                borderColor: llmChoice.openclaw.bin_exists ? "var(--accent)" : "var(--border)",
                opacity: savingChoice && savingChoice !== "openclaw" ? 0.5 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Cloud size={16} style={{ color: "var(--accent)" }} />
                <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>OpenClaw (premium)</strong>
                <span style={badgeStyle("var(--accent)")}>Paga</span>
              </div>
              <p style={choiceBodyStyle}>
                Usa o CLI OpenClaw, que pode estar plugado em Claude / GPT /
                Gemini. Qualidade muito maior em extração e síntese, mas
                consome tokens conforme seu provedor. Requer o binário
                configurado.
              </p>
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
                {llmChoice.openclaw.bin_exists
                  ? `✅ Binário detectado: ${llmChoice.openclaw.bin}`
                  : `⚠️ Binário "${llmChoice.openclaw.bin}" não encontrado — configure em Settings`}
              </div>
              {savingChoice === "openclaw" && (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <Loader2 size={11} className="animate-spin" /> Salvando…
                </div>
              )}
            </button>

            {/* LATER CARD */}
            <button
              type="button"
              onClick={() => chooseLLM("later")}
              disabled={savingChoice !== null}
              style={{
                ...choiceCardStyle,
                opacity: savingChoice && savingChoice !== "later" ? 0.5 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Timer size={16} style={{ color: "var(--text-muted)" }} />
                <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Decidir depois</strong>
              </div>
              <p style={choiceBodyStyle}>
                Pula a escolha agora. A memória adaptativa fica parada até
                você configurar uma LLM, mas você pode mexer no resto do
                AtlasDeck normalmente. Vamos lembrar você na sineta.
              </p>
              {savingChoice === "later" && (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <Loader2 size={11} className="animate-spin" /> Salvando…
                </div>
              )}
            </button>
          </div>

          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
            💡 Se você escolher OpenClaw e o Ollama também estiver disponível,
            o Ollama vira backup automático — se a LLM premium falhar (sem
            tokens, timeout, etc.), o agente continua funcionando localmente.
          </p>
        </div>
      )}

      {/* INTRO PHASE: explanation + start/manual buttons + Ollama status */}
      {phase === "intro" && history.length === 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Info size={14} style={{ color: "var(--accent)" }} />
              <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                O que esse wizard faz?
              </strong>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
              O OpenClaw nasce sem te conhecer. Os arquivos{" "}
              <code>IDENTITY.md</code>, <code>SOUL.md</code> e{" "}
              <code>USER.md</code> são lidos no início de toda sessão — é por
              eles que o agente sabe quem você é, como você gosta de trabalhar
              e qual é a personalidade dele.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
              O wizard vai te entrevistar com 5-8 perguntas curtas, depois{" "}
              <strong>gera os três arquivos automaticamente</strong> com base
              nas suas respostas. Você revê tudo antes de salvar — e os
              arquivos atuais ficam guardados como <code>.bak.&lt;data&gt;</code>.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              Resultado: a partir da próxima conversa com o agente, ele já abre
              te conhecendo. Essa configuração é a fundação da memória adaptativa
              — sem ela, o sistema continua extraindo das suas sessões, mas
              começa do zero.
            </p>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 8,
              background: "var(--bg)",
              border: `1px solid ${llmAvailable ? "var(--success, #32D74B)" : "var(--warning, #FFD60A)"}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Cpu
                size={14}
                style={{ color: llmAvailable ? "var(--success, #32D74B)" : "var(--warning, #FFD60A)" }}
              />
              <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                LLM disponível
              </strong>
            </div>
            {ollama && llmAvailable ? (
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                ✅ Ollama rodando localmente · {ollama.models.length} modelo(s) local.
                A entrevista vai usar seu LLM local (zero custo). Se preferir
                qualidade maior via OpenClaw, troque em <strong>Configurações → Extrator</strong>.
              </p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 8 }}>
                  ⚠️ Ollama não detectado. O wizard pode rodar via{" "}
                  <strong>OpenClaw CLI</strong> (consome tokens conforme seu
                  modelo configurado), mas a forma <strong>recomendada e gratuita</strong>{" "}
                  é instalar Ollama localmente.
                </p>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  💡 Como ativar: vai em <strong>Memória → Configurações → Extrator de memórias</strong>,
                  clica no card <strong>"Ollama local"</strong> e:
                </p>
                <ol style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, paddingLeft: 20, lineHeight: 1.7 }}>
                  <li>Clica em <strong>"Instalar Ollama (Linux)"</strong> se ainda não tiver</li>
                  <li>Baixa o modelo recomendado: <strong>Qwen 2.5 7B</strong> (~5 GB disco, ~8 GB RAM)</li>
                  <li>Volta aqui e o wizard já vai usar local — toda a memória adaptativa também passa a ser zero custo</li>
                </ol>
              </>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={startInterview} style={primaryButtonStyle}>
              <PlayCircle size={14} /> Começar entrevista
            </button>
            {onSwitchToFilesTab && (
              <button
                type="button"
                onClick={onSwitchToFilesTab}
                style={ghostButtonStyle}
                title="Editar IDENTITY.md, SOUL.md, USER.md à mão"
              >
                <Edit3 size={13} /> Preencher manualmente
              </button>
            )}
          </div>
        </div>
      )}

      {/* History transcript */}
      {history.length > 0 && phase !== "saved" && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {history.map((turn, i) => (
            <div
              key={i}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--bg)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                Pergunta {i + 1}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 6 }}>
                {turn.question}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", paddingLeft: 12, borderLeft: "2px solid var(--accent)" }}>
                {turn.answer}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Interview phase: current question + answer input */}
      {phase === "interview" && (
        <div style={{ marginTop: 14 }}>
          {askingNext && !currentQuestion ? (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <Loader2 size={14} className="animate-spin" /> Pensando na próxima pergunta…
            </div>
          ) : summary ? (
            <div
              style={{
                padding: 14,
                borderRadius: 8,
                background: "var(--accent-soft, rgba(255,59,48,0.08))",
                border: "1px solid var(--accent)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <CheckCircle2 size={16} style={{ color: "var(--accent)" }} />
                <strong style={{ fontSize: 13, color: "var(--accent)" }}>
                  Tenho contexto suficiente
                </strong>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5, marginBottom: 12 }}>
                {summary}
              </p>
              <button type="button" onClick={generate} disabled={generating} style={primaryButtonStyle}>
                <Sparkles size={13} /> Gerar arquivos e revisar
              </button>
            </div>
          ) : currentQuestion ? (
            <div
              style={{
                padding: 14,
                borderRadius: 8,
                background: "var(--bg)",
                border: "1px solid var(--accent)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <MessageCircle size={14} style={{ color: "var(--accent)" }} />
                <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                  Pergunta {history.length + 1}
                </strong>
              </div>
              <div style={{ fontSize: 14, color: "var(--text-primary)", marginBottom: 10 }}>
                {currentQuestion}
              </div>
              <textarea
                ref={answerRef}
                value={currentAnswer}
                onChange={(e) => setCurrentAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submitAnswer();
                  }
                }}
                placeholder="Sua resposta… (Ctrl/Cmd+Enter para enviar)"
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  fontFamily: "var(--font-body)",
                  outline: "none",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
                <button type="button" onClick={skipQuestion} disabled={askingNext} style={ghostButtonStyle}>
                  Pular
                </button>
                <button
                  type="button"
                  onClick={submitAnswer}
                  disabled={!currentAnswer.trim() || askingNext}
                  style={primaryButtonStyle}
                >
                  {askingNext ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                  Próxima
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {phase === "generating" && (
        <div style={{ marginTop: 14, padding: 14, fontSize: 13, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={14} className="animate-spin" /> Gerando IDENTITY.md, SOUL.md e USER.md a partir da entrevista…
        </div>
      )}

      {/* Review phase: tabbed editors */}
      {phase === "review" && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {FILE_NAMES.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setActiveDraft(f)}
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: activeDraft === f ? 600 : 500,
                  border: "none",
                  borderBottom: activeDraft === f ? "2px solid var(--accent)" : "2px solid transparent",
                  background: "transparent",
                  color: activeDraft === f ? "var(--accent)" : "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                {f}
              </button>
            ))}
          </div>

          <textarea
            value={drafts[activeDraft]}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [activeDraft]: e.target.value }))}
            rows={18}
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-primary)",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
              outline: "none",
              resize: "vertical",
            }}
          />

          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Você pode editar livremente antes de salvar. Os arquivos atuais
            do workspace serão renomeados para <code>.bak.&lt;timestamp&gt;</code> antes
            de serem sobrescritos.
          </p>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button type="button" onClick={() => setPhase("interview")} style={ghostButtonStyle}>
              Voltar
            </button>
            <button type="button" onClick={generate} disabled={generating} style={ghostButtonStyle}>
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Regerar
            </button>
            <button type="button" onClick={save} disabled={saving} style={primaryButtonStyle}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Salvar no workspace
            </button>
          </div>
        </div>
      )}

      {phase === "saved" && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 8,
            background: "var(--accent-soft, rgba(50,215,75,0.08))",
            border: "1px solid var(--success, #32D74B)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <CheckCircle2 size={16} style={{ color: "var(--success, #32D74B)" }} />
            <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
              Arquivos salvos em {workspace}
            </strong>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
            IDENTITY.md, SOUL.md e USER.md foram gravados. Recomendado agora:
            importar pra popular o índice semântico.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={importNow} style={primaryButtonStyle}>
              Importar pra memória semântica
            </button>
            <button type="button" onClick={reset} style={ghostButtonStyle}>
              Nova entrevista
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--bg)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const ghostButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
};

const choiceCardStyle: React.CSSProperties = {
  textAlign: "left",
  padding: 14,
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "transform 120ms ease, border-color 120ms ease",
};

const choiceBodyStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
  margin: 0,
};

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: 4,
    background: "transparent",
    color,
    border: `1px solid ${color}`,
    marginLeft: "auto",
  };
}
