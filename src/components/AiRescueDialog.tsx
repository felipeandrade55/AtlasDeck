"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  X,
  Loader2,
  Bot,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Play,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Terminal as TerminalIcon,
  ArrowLeft,
  ScrollText,
} from "lucide-react";

type AiMode = "analyze" | "fix";
type AiCli = "auto" | "claude" | "codex";
type AiPhase = "analyze" | "execute";
type DialogStage = "form" | "running" | "review" | "confirm-destructive" | "done" | "error";

export interface AiRescueContext {
  /** Function returning a fresh diagnostic snapshot string (called per request). */
  buildSnapshot: () => string;
  claudeAvailable: boolean;
  codexAvailable: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: AiRescueContext;
}

interface MetaInfo {
  cli?: string;
  phase?: AiPhase;
  command?: string;
}

interface ErrorInfo {
  kind: string;
  message: string;
  hint?: string;
}

interface PlanItem {
  step: number;
  command: string;
  severity: "safe" | "caution" | "destructive";
  description: string;
}

interface AnalyzeResult {
  diagnostico?: string;
  causa?: string;
  plano: PlanItem[];
  resumo?: string;
  destructive: string[];
  raw: string;
}

interface ExecuteResult {
  resultado?: string;
  passos?: string;
  estado?: string;
  proximos?: string;
  raw: string;
}

// ── Parsers ──────────────────────────────────────────────────────────────

function parseMarkdownSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) out[cur.trim()] = buf.join("\n").trim();
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      cur = m[1];
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function parsePlan(text?: string): PlanItem[] {
  if (!text) return [];
  const items: PlanItem[] = [];
  for (const line of text.split("\n")) {
    // 1. `cmd` — [SAFE] descrição
    const m = line.match(/^\s*(\d+)\.\s*`([^`]+)`\s*[—\-–:]\s*\[(SAFE|CAUTION|DESTRUCTIVE)\]\s*(.*)$/i);
    if (m) {
      const sev = m[3].toLowerCase();
      items.push({
        step: parseInt(m[1], 10),
        command: m[2],
        severity: sev === "destructive" ? "destructive" : sev === "caution" ? "caution" : "safe",
        description: m[4].trim(),
      });
      continue;
    }
    // 1. [SAFE] `cmd` — descrição
    const m2 = line.match(/^\s*(\d+)\.\s*\[(SAFE|CAUTION|DESTRUCTIVE)\]\s*`([^`]+)`\s*[—\-–:]?\s*(.*)$/i);
    if (m2) {
      const sev = m2[2].toLowerCase();
      items.push({
        step: parseInt(m2[1], 10),
        command: m2[3],
        severity: sev === "destructive" ? "destructive" : sev === "caution" ? "caution" : "safe",
        description: m2[4].trim(),
      });
    }
  }
  return items;
}

function parseAnalyzeOutput(text: string, destructiveFromServer: string[]): AnalyzeResult {
  const s = parseMarkdownSections(text);
  const planText = s["Plano de correção"] ?? s["Plano de correcao"] ?? s["Plano"];
  return {
    diagnostico: s["Diagnóstico"] ?? s["Diagnostico"],
    causa: s["Causa provável"] ?? s["Causa provavel"] ?? s["Causa"],
    plano: parsePlan(planText),
    resumo: s["Resumo"],
    destructive: destructiveFromServer,
    raw: text,
  };
}

function parseExecuteOutput(text: string): ExecuteResult {
  const s = parseMarkdownSections(text);
  return {
    resultado: s["Resultado"],
    passos: s["Passos executados"] ?? s["Passos"],
    estado: s["Estado atual"] ?? s["Estado"],
    proximos: s["Próximos passos para o humano"] ?? s["Próximos passos"] ?? s["Proximos passos"],
    raw: text,
  };
}

// ── Component ────────────────────────────────────────────────────────────

export function AiRescueDialog({ open, onClose, context }: Props) {
  const [problem, setProblem] = useState("");
  const [mode, setMode] = useState<AiMode>("analyze");
  const [cli, setCli] = useState<AiCli>("auto");
  const [stage, setStage] = useState<DialogStage>("form");
  const [meta, setMeta] = useState<MetaInfo>({});
  const [streamingOutput, setStreamingOutput] = useState("");
  const [streamingStderr, setStreamingStderr] = useState("");
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll streaming output
  useEffect(() => {
    if (stage === "running" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamingOutput, streamingStderr, stage]);

  // Reset when closed
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  const resetForNew = useCallback(() => {
    setStage("form");
    setMeta({});
    setStreamingOutput("");
    setStreamingStderr("");
    setAnalyzeResult(null);
    setExecuteResult(null);
    setError(null);
    setDuration(null);
    setShowRaw(false);
    setPendingDestructive([]);
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    resetForNew();
    setProblem("");
    onClose();
  }, [onClose, resetForNew]);

  const runPhase = useCallback(
    async (phase: AiPhase, planForExecute?: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setStage("running");
      setMeta({ phase });
      setStreamingOutput("");
      setStreamingStderr("");
      setError(null);
      setDuration(null);
      setShowRaw(false);
      if (phase === "analyze") {
        setAnalyzeResult(null);
        setExecuteResult(null);
      } else {
        setExecuteResult(null);
      }

      try {
        const res = await fetch("/api/recovery/ai-fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            problem,
            mode,
            cli,
            phase,
            context: context.buildSnapshot(),
            plan: planForExecute,
          }),
          signal: ctrl.signal,
        });

        if (!res.body) {
          throw new Error("Sem corpo de resposta");
        }

        // Non-stream error (e.g. JSON error from cli_missing or hard_blocked)
        const ctype = res.headers.get("content-type") || "";
        if (!ctype.includes("text/event-stream")) {
          const data = await res.json();
          setError({
            kind: data.kind || "unknown",
            message: data.message || data.error || "Falha desconhecida",
            hint: data.hint,
          });
          setStage("error");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let localStdout = "";
        let localStderr = "";
        let serverDestructive: string[] = [];

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (!block.startsWith("data: ")) continue;
            const payload = block.slice(6);
            let evt: { event: string; [k: string]: unknown };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (evt.event === "meta") {
              setMeta({
                cli: evt.cli as string,
                phase: evt.phase as AiPhase,
                command: evt.command as string,
              });
            } else if (evt.event === "chunk") {
              const text = (evt.text as string) || "";
              if (evt.source === "stderr") {
                localStderr += text;
                setStreamingStderr(localStderr);
              } else {
                localStdout += text;
                setStreamingOutput(localStdout);
              }
            } else if (evt.event === "error") {
              setError({
                kind: (evt.kind as string) || "unknown",
                message: (evt.message as string) || "Erro durante execução",
                hint: evt.hint as string | undefined,
              });
            } else if (evt.event === "done") {
              setDuration((evt.durationMs as number) || null);
              serverDestructive = (evt.destructive as string[]) || [];
            }
          }
        }

        // Finalized
        if (phase === "analyze") {
          const parsed = parseAnalyzeOutput(localStdout, serverDestructive);
          setAnalyzeResult(parsed);

          if (parsed.plano.length === 0 && !parsed.diagnostico) {
            setError({
              kind: "parse_empty",
              message: "A IA não retornou um plano estruturado.",
              hint: "Tente reformular o problema ou trocar o CLI.",
            });
            setStage("error");
            return;
          }

          const hasDestructive =
            parsed.destructive.length > 0 ||
            parsed.plano.some((p) => p.severity === "destructive");

          if (mode === "fix") {
            if (hasDestructive) {
              setPendingDestructive(
                parsed.destructive.length
                  ? parsed.destructive
                  : parsed.plano.filter((p) => p.severity === "destructive").map((p) => `${p.step}. ${p.command} — ${p.description}`),
              );
              setStage("confirm-destructive");
            } else {
              // Auto-execute
              void runPhase("execute", parsed.raw);
            }
          } else {
            setStage("review");
          }
        } else {
          // execute phase
          setExecuteResult(parseExecuteOutput(localStdout));
          setStage("done");
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // user-initiated cancel
          return;
        }
        setError({
          kind: "network",
          message: e instanceof Error ? e.message : String(e),
        });
        setStage("error");
      }
    },
    [problem, mode, cli, context],
  );

  const cancelRunning = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage(analyzeResult ? "review" : "form");
  }, [analyzeResult]);

  const approveAndExecute = useCallback(() => {
    if (!analyzeResult) return;
    const hasDestructive =
      analyzeResult.destructive.length > 0 ||
      analyzeResult.plano.some((p) => p.severity === "destructive");
    if (hasDestructive) {
      setPendingDestructive(
        analyzeResult.destructive.length
          ? analyzeResult.destructive
          : analyzeResult.plano.filter((p) => p.severity === "destructive").map((p) => `${p.step}. ${p.command} — ${p.description}`),
      );
      setStage("confirm-destructive");
    } else {
      void runPhase("execute", analyzeResult.raw);
    }
  }, [analyzeResult, runPhase]);

  const confirmDestructiveAndExecute = useCallback(() => {
    if (!analyzeResult) return;
    setPendingDestructive([]);
    void runPhase("execute", analyzeResult.raw);
  }, [analyzeResult, runPhase]);

  // Esc closes (when not running)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stage !== "running") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stage, handleClose]);

  const aiAvailable = context.claudeAvailable || context.codexAvailable;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={stage !== "running" ? handleClose : undefined}
    >
      <div
        className="w-full max-w-5xl rounded-xl flex flex-col overflow-hidden"
        style={{
          maxHeight: "92vh",
          backgroundColor: "var(--card)",
          border: "1px solid rgba(139, 92, 246, 0.4)",
          boxShadow: "0 25px 80px rgba(0,0,0,0.5), 0 0 60px rgba(139, 92, 246, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 border-b shrink-0"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-5 h-5 shrink-0" style={{ color: "#a78bfa" }} />
            <h2 className="font-semibold text-base sm:text-lg truncate" style={{ color: "var(--text-primary)" }}>
              Assistente de Resgate IA
            </h2>
            <StageBadge stage={stage} mode={mode} />
          </div>
          <button
            onClick={handleClose}
            disabled={stage === "running"}
            className="p-1.5 rounded-md hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" style={{ color: "var(--text-secondary)" }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage === "form" && (
            <FormStage
              problem={problem}
              setProblem={setProblem}
              mode={mode}
              setMode={setMode}
              cli={cli}
              setCli={setCli}
              aiAvailable={aiAvailable}
              claudeAvailable={context.claudeAvailable}
              codexAvailable={context.codexAvailable}
            />
          )}

          {stage === "running" && (
            <RunningStage
              phase={meta.phase || "analyze"}
              stdout={streamingOutput}
              stderr={streamingStderr}
              outputRef={outputRef}
            />
          )}

          {stage === "review" && analyzeResult && (
            <ReviewStage result={analyzeResult} showRaw={showRaw} setShowRaw={setShowRaw} />
          )}

          {stage === "confirm-destructive" && (
            <ConfirmDestructiveStage destructive={pendingDestructive} />
          )}

          {stage === "done" && executeResult && (
            <DoneStage result={executeResult} showRaw={showRaw} setShowRaw={setShowRaw} />
          )}

          {stage === "error" && error && (
            <ErrorStage error={error} stdout={streamingOutput} stderr={streamingStderr} />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-5 py-3 border-t shrink-0"
          style={{ borderColor: "var(--border)", backgroundColor: "rgba(0,0,0,0.2)" }}
        >
          <MetaFooter meta={meta} duration={duration} />
          <FooterActions
            stage={stage}
            mode={mode}
            aiAvailable={aiAvailable}
            problemEmpty={problem.trim().length === 0}
            onStart={() => runPhase("analyze")}
            onCancel={cancelRunning}
            onClose={handleClose}
            onApprove={approveAndExecute}
            onBackToForm={resetForNew}
            onConfirmDestructive={confirmDestructiveAndExecute}
            onRetry={() => runPhase(meta.phase || "analyze", analyzeResult?.raw)}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function StageBadge({ stage, mode }: { stage: DialogStage; mode: AiMode }) {
  const map: Record<DialogStage, { label: string; color: string; bg: string }> = {
    form: { label: mode === "fix" ? "Correção" : "Análise", color: "#a78bfa", bg: "rgba(139, 92, 246, 0.15)" },
    running: { label: "Executando…", color: "#facc15", bg: "rgba(234, 179, 8, 0.15)" },
    review: { label: "Plano pronto", color: "#60a5fa", bg: "rgba(96, 165, 250, 0.15)" },
    "confirm-destructive": { label: "Atenção: destrutivo", color: "#fca5a5", bg: "rgba(239, 68, 68, 0.15)" },
    done: { label: "Concluído", color: "#34d399", bg: "rgba(16, 185, 129, 0.15)" },
    error: { label: "Falhou", color: "#f87171", bg: "rgba(239, 68, 68, 0.15)" },
  };
  const s = map[stage];
  return (
    <span
      className="hidden sm:inline-flex items-center text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-medium ml-2"
      style={{ color: s.color, backgroundColor: s.bg, border: `1px solid ${s.color}40` }}
    >
      {s.label}
    </span>
  );
}

function FormStage({
  problem, setProblem, mode, setMode, cli, setCli,
  aiAvailable, claudeAvailable, codexAvailable,
}: {
  problem: string; setProblem: (s: string) => void;
  mode: AiMode; setMode: (m: AiMode) => void;
  cli: AiCli; setCli: (c: AiCli) => void;
  aiAvailable: boolean; claudeAvailable: boolean; codexAvailable: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium block mb-2" style={{ color: "var(--text-primary)" }}>
          O que está acontecendo?
        </label>
        <textarea
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          placeholder="Ex: 'o gateway voltou 503', 'os agentes pararam de responder desde a madrugada', 'disco encheu', 'mission-control reiniciou sozinho'…"
          rows={5}
          autoFocus
          className="w-full rounded-lg px-3 py-2.5 text-sm resize-y"
          style={{
            backgroundColor: "rgba(0,0,0,0.3)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            minHeight: 110,
          }}
        />
        <p className="text-xs mt-1.5" style={{ color: "var(--text-muted)" }}>
          O snapshot atual do sistema (OpenClaw, gateway, Linux, últimas ações) é enviado junto automaticamente.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ModeCard
          selected={mode === "analyze"}
          onSelect={() => setMode("analyze")}
          icon={ScrollText}
          title="Analisar e aprovar"
          desc="A IA diagnostica e propõe um plano. Você aprova antes de executar."
          accent="#60a5fa"
        />
        <ModeCard
          selected={mode === "fix"}
          onSelect={() => setMode("fix")}
          icon={ShieldAlert}
          title="Corrigir automaticamente"
          desc="A IA corrige direto. Só pede confirmação se houver comando destrutivo."
          accent="#fbbf24"
        />
      </div>

      <div className="flex items-center justify-between gap-3 p-3 rounded-lg" style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>CLI de IA</span>
        </div>
        <select
          value={cli}
          onChange={(e) => setCli(e.target.value as AiCli)}
          className="text-xs rounded px-2 py-1.5"
          style={{ backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
        >
          <option value="auto">Automático (prefere Claude)</option>
          <option value="claude" disabled={!claudeAvailable}>
            Claude Code {!claudeAvailable && "— não instalado"}
          </option>
          <option value="codex" disabled={!codexAvailable}>
            Codex {!codexAvailable && "— não instalado"}
          </option>
        </select>
      </div>

      {!aiAvailable && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg text-xs"
          style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" }}
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            Nenhum CLI de IA está instalado no servidor.
            Instale <code>claude</code> (<code>npm i -g @anthropic-ai/claude-code</code>) ou <code>codex</code> para usar essa função.
          </div>
        </div>
      )}
    </div>
  );
}

function ModeCard({
  selected, onSelect, icon: Icon, title, desc, accent,
}: {
  selected: boolean; onSelect: () => void;
  icon: typeof ScrollText; title: string; desc: string; accent: string;
}) {
  return (
    <button
      onClick={onSelect}
      className="text-left rounded-lg p-3 transition-all"
      style={{
        backgroundColor: selected ? `${accent}1A` : "rgba(0,0,0,0.25)",
        border: `1px solid ${selected ? accent : "var(--border)"}`,
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4" style={{ color: accent }} />
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{desc}</p>
    </button>
  );
}

function RunningStage({
  phase, stdout, stderr, outputRef,
}: {
  phase: AiPhase; stdout: string; stderr: string;
  outputRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-3 p-3 rounded-lg"
        style={{ backgroundColor: "rgba(139, 92, 246, 0.08)", border: "1px solid rgba(139, 92, 246, 0.3)" }}
      >
        <Loader2 className="w-5 h-5 animate-spin shrink-0" style={{ color: "#a78bfa" }} />
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {phase === "execute" ? "Executando correção…" : "Analisando o problema…"}
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            {phase === "execute"
              ? "A IA está aplicando o plano aprovado. Pode levar alguns minutos."
              : "A IA está investigando. Você verá a saída ao vivo abaixo."}
          </div>
        </div>
      </div>
      <div
        ref={outputRef}
        className="rounded-lg p-3 font-mono text-[11px] whitespace-pre-wrap overflow-auto"
        style={{
          backgroundColor: "rgba(0,0,0,0.5)",
          border: "1px solid var(--border)",
          color: "var(--text-primary)",
          maxHeight: "55vh",
          minHeight: 240,
        }}
      >
        {stdout || (
          <span style={{ color: "var(--text-muted)" }}>
            Aguardando saída do CLI…
          </span>
        )}
        {stderr && (
          <div className="mt-3 pt-2 border-t" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
            <div className="text-[10px] uppercase mb-1" style={{ color: "#f87171" }}>stderr</div>
            <div style={{ color: "#fca5a5" }}>{stderr}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewStage({
  result, showRaw, setShowRaw,
}: { result: AnalyzeResult; showRaw: boolean; setShowRaw: (b: boolean) => void }) {
  const hasDestructive = result.destructive.length > 0 || result.plano.some((p) => p.severity === "destructive");
  return (
    <div className="space-y-4">
      {result.diagnostico && (
        <Section title="Diagnóstico" icon={Sparkles} accent="#a78bfa">
          <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>{result.diagnostico}</p>
        </Section>
      )}

      {result.causa && (
        <Section title="Causa provável" icon={AlertCircle} accent="#fbbf24">
          <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>{result.causa}</p>
        </Section>
      )}

      <Section title="Plano de correção" icon={ScrollText} accent="#60a5fa">
        {result.plano.length === 0 ? (
          <p className="text-sm italic" style={{ color: "var(--text-muted)" }}>
            A IA não retornou um plano em formato estruturado. Veja &ldquo;Detalhes técnicos&rdquo; abaixo.
          </p>
        ) : (
          <ol className="space-y-2">
            {result.plano.map((step) => (
              <PlanStepRow key={step.step} step={step} />
            ))}
          </ol>
        )}
      </Section>

      {hasDestructive && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg text-sm"
          style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.4)" }}
        >
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium" style={{ color: "#fca5a5" }}>Este plano contém ações destrutivas.</div>
            <div className="text-xs mt-0.5" style={{ color: "#fca5a5" }}>
              Você será solicitado a confirmar antes de qualquer comando irreversível.
            </div>
          </div>
        </div>
      )}

      {result.resumo && (
        <div className="text-xs italic" style={{ color: "var(--text-muted)" }}>
          {result.resumo}
        </div>
      )}

      <RawToggle showRaw={showRaw} setShowRaw={setShowRaw} raw={result.raw} />
    </div>
  );
}

function PlanStepRow({ step }: { step: PlanItem }) {
  const styles: Record<PlanItem["severity"], { color: string; bg: string; label: string }> = {
    safe: { color: "#34d399", bg: "rgba(16, 185, 129, 0.12)", label: "SEGURO" },
    caution: { color: "#facc15", bg: "rgba(234, 179, 8, 0.12)", label: "CUIDADO" },
    destructive: { color: "#fca5a5", bg: "rgba(239, 68, 68, 0.12)", label: "DESTRUTIVO" },
  };
  const s = styles[step.severity];
  return (
    <li
      className="rounded-lg p-2.5 flex items-start gap-3"
      style={{ backgroundColor: s.bg, border: `1px solid ${s.color}40` }}
    >
      <span
        className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 uppercase tracking-wider mt-0.5"
        style={{ color: s.color, backgroundColor: `${s.color}20` }}
      >
        {step.step}
      </span>
      <div className="min-w-0 flex-1">
        <code className="text-xs font-mono block break-all" style={{ color: s.color }}>
          {step.command}
        </code>
        {step.description && (
          <div className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>{step.description}</div>
        )}
      </div>
      <span
        className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded shrink-0"
        style={{ color: s.color, backgroundColor: `${s.color}20` }}
      >
        {s.label}
      </span>
    </li>
  );
}

function ConfirmDestructiveStage({ destructive }: { destructive: string[] }) {
  return (
    <div className="space-y-3">
      <div
        className="flex items-start gap-3 p-4 rounded-lg"
        style={{ backgroundColor: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)" }}
      >
        <ShieldAlert className="w-6 h-6 shrink-0" style={{ color: "#fca5a5" }} />
        <div>
          <h3 className="font-semibold text-sm" style={{ color: "#fca5a5" }}>
            Confirmação necessária — comandos destrutivos
          </h3>
          <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
            O plano contém comandos que podem apagar dados ou interromper serviços de forma irreversível.
            Revise abaixo e confirme se autoriza a execução.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {destructive.length === 0 ? (
          <p className="text-sm italic" style={{ color: "var(--text-muted)" }}>(nenhum comando isolado identificado)</p>
        ) : (
          destructive.map((line, i) => (
            <div
              key={i}
              className="rounded p-2 font-mono text-xs"
              style={{ backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5" }}
            >
              {line}
            </div>
          ))
        )}
      </div>

      <div
        className="text-xs p-2.5 rounded"
        style={{ backgroundColor: "rgba(0,0,0,0.3)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
      >
        Mesmo confirmando, comandos da blocklist absoluta (rm -rf /, mkfs, shutdown, etc.) seguem bloqueados pelo backend.
      </div>
    </div>
  );
}

function DoneStage({
  result, showRaw, setShowRaw,
}: { result: ExecuteResult; showRaw: boolean; setShowRaw: (b: boolean) => void }) {
  const status = (result.resultado || "").toLowerCase();
  const accent = status.includes("ok") || status.includes("tudo")
    ? "#34d399"
    : status.includes("parcial")
    ? "#facc15"
    : status.includes("falhou") || status.includes("erro")
    ? "#f87171"
    : "#a78bfa";
  return (
    <div className="space-y-4">
      {result.resultado && (
        <Section title="Resultado" icon={CheckCircle2} accent={accent}>
          <p className="text-sm font-medium" style={{ color: accent }}>{result.resultado}</p>
        </Section>
      )}
      {result.passos && (
        <Section title="Passos executados" icon={ScrollText} accent="#60a5fa">
          <pre className="text-xs font-mono whitespace-pre-wrap" style={{ color: "var(--text-primary)" }}>{result.passos}</pre>
        </Section>
      )}
      {result.estado && (
        <Section title="Estado atual" icon={Sparkles} accent="#a78bfa">
          <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>{result.estado}</p>
        </Section>
      )}
      {result.proximos && (
        <Section title="Próximos passos" icon={AlertCircle} accent="#fbbf24">
          <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>{result.proximos}</p>
        </Section>
      )}

      {!result.resultado && !result.passos && !result.estado && (
        <p className="text-sm italic" style={{ color: "var(--text-muted)" }}>
          A IA executou mas não retornou um relatório estruturado. Veja &ldquo;Detalhes técnicos&rdquo;.
        </p>
      )}

      <RawToggle showRaw={showRaw} setShowRaw={setShowRaw} raw={result.raw} />
    </div>
  );
}

function ErrorStage({ error, stdout, stderr }: { error: ErrorInfo; stdout: string; stderr: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="space-y-3">
      <div
        className="flex items-start gap-3 p-4 rounded-lg"
        style={{ backgroundColor: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)" }}
      >
        <XCircle className="w-6 h-6 shrink-0" style={{ color: "#f87171" }} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm" style={{ color: "#fca5a5" }}>
            {humanizeErrorKind(error.kind)}
          </h3>
          <p className="text-sm mt-1" style={{ color: "var(--text-primary)" }}>{error.message}</p>
          {error.hint && (
            <div
              className="mt-2.5 p-2.5 rounded text-xs"
              style={{ backgroundColor: "rgba(0,0,0,0.3)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              <strong style={{ color: "#fbbf24" }}>Como resolver:</strong> {error.hint}
            </div>
          )}
        </div>
      </div>

      {(stdout || stderr) && (
        <RawToggle
          showRaw={showRaw}
          setShowRaw={setShowRaw}
          raw={`${stdout}${stderr ? `\n\n[stderr]\n${stderr}` : ""}`}
        />
      )}
    </div>
  );
}

function humanizeErrorKind(kind: string): string {
  const map: Record<string, string> = {
    model_not_supported: "Modelo do Codex incompatível",
    not_authenticated: "CLI de IA não autenticado",
    rate_limit: "Limite de uso atingido",
    cli_missing: "CLI de IA não encontrado",
    hard_blocked: "Comando proibido detectado",
    parse_empty: "Resposta da IA vazia ou malformada",
    network: "Falha de comunicação",
    unknown: "Falha desconhecida",
  };
  return map[kind] || `Falha (${kind})`;
}

function Section({
  title, icon: Icon, accent, children,
}: { title: string; icon: typeof Sparkles; accent: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color: accent }} />
        <h4 className="text-xs uppercase tracking-wider font-semibold" style={{ color: accent }}>{title}</h4>
      </div>
      {children}
    </div>
  );
}

function RawToggle({
  showRaw, setShowRaw, raw,
}: { showRaw: boolean; setShowRaw: (b: boolean) => void; raw: string }) {
  return (
    <details
      open={showRaw}
      onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}
      className="rounded-lg overflow-hidden"
      style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
    >
      <summary
        className="cursor-pointer px-3 py-2 text-xs flex items-center gap-2 select-none"
        style={{ color: "var(--text-secondary)" }}
      >
        <TerminalIcon className="w-3.5 h-3.5" />
        Detalhes técnicos (resposta crua do CLI)
        {showRaw ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
      </summary>
      <pre
        className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap overflow-auto"
        style={{ color: "var(--text-primary)", maxHeight: 320, backgroundColor: "rgba(0,0,0,0.4)" }}
      >
        {raw || "(vazio)"}
      </pre>
    </details>
  );
}

function MetaFooter({ meta, duration }: { meta: MetaInfo; duration: number | null }) {
  if (!meta.cli && !meta.phase && duration === null) {
    return <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Pronto para começar.</span>;
  }
  return (
    <div className="text-[11px] flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ color: "var(--text-muted)" }}>
      {meta.cli && <span>via <b style={{ color: "var(--text-secondary)" }}>{meta.cli}</b></span>}
      {meta.phase && <span>fase: <b style={{ color: "var(--text-secondary)" }}>{meta.phase === "execute" ? "execução" : "análise"}</b></span>}
      {duration !== null && <span>{(duration / 1000).toFixed(1)}s</span>}
      {meta.command && (
        <span className="hidden md:inline truncate max-w-md" title={meta.command}>
          <code style={{ color: "var(--text-secondary)" }}>{meta.command}</code>
        </span>
      )}
    </div>
  );
}

function FooterActions({
  stage, mode, aiAvailable, problemEmpty,
  onStart, onCancel, onClose, onApprove, onBackToForm, onConfirmDestructive, onRetry,
}: {
  stage: DialogStage; mode: AiMode; aiAvailable: boolean; problemEmpty: boolean;
  onStart: () => void; onCancel: () => void; onClose: () => void;
  onApprove: () => void; onBackToForm: () => void;
  onConfirmDestructive: () => void; onRetry: () => void;
}) {
  if (stage === "form") {
    return (
      <div className="flex items-center gap-2 justify-end">
        <SecondaryBtn onClick={onClose}>Cancelar</SecondaryBtn>
        <PrimaryBtn onClick={onStart} disabled={!aiAvailable || problemEmpty} accent="#a78bfa">
          <Sparkles className="w-4 h-4" />
          {mode === "fix" ? "Analisar e corrigir" : "Analisar problema"}
        </PrimaryBtn>
      </div>
    );
  }
  if (stage === "running") {
    return (
      <div className="flex items-center gap-2 justify-end">
        <SecondaryBtn onClick={onCancel}>
          <XCircle className="w-3.5 h-3.5" />
          Cancelar
        </SecondaryBtn>
      </div>
    );
  }
  if (stage === "review") {
    return (
      <div className="flex items-center gap-2 justify-end">
        <SecondaryBtn onClick={onBackToForm}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Voltar
        </SecondaryBtn>
        <PrimaryBtn onClick={onApprove} accent="#34d399">
          <Play className="w-4 h-4" />
          Aprovar e corrigir
        </PrimaryBtn>
      </div>
    );
  }
  if (stage === "confirm-destructive") {
    return (
      <div className="flex items-center gap-2 justify-end">
        <SecondaryBtn onClick={onBackToForm}>Cancelar</SecondaryBtn>
        <PrimaryBtn onClick={onConfirmDestructive} accent="#f87171">
          <ShieldAlert className="w-4 h-4" />
          Confirmar e executar
        </PrimaryBtn>
      </div>
    );
  }
  if (stage === "done") {
    return (
      <div className="flex items-center gap-2 justify-end">
        <SecondaryBtn onClick={onBackToForm}>
          <RotateCcw className="w-3.5 h-3.5" />
          Nova análise
        </SecondaryBtn>
        <PrimaryBtn onClick={onClose} accent="#34d399">
          <CheckCircle2 className="w-4 h-4" />
          Fechar
        </PrimaryBtn>
      </div>
    );
  }
  // error
  return (
    <div className="flex items-center gap-2 justify-end">
      <SecondaryBtn onClick={onBackToForm}>
        <ArrowLeft className="w-3.5 h-3.5" />
        Voltar ao formulário
      </SecondaryBtn>
      <PrimaryBtn onClick={onRetry} accent="#a78bfa">
        <RotateCcw className="w-4 h-4" />
        Tentar novamente
      </PrimaryBtn>
    </div>
  );
}

function PrimaryBtn({
  onClick, disabled, accent, children,
}: { onClick: () => void; disabled?: boolean; accent: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        backgroundColor: `${accent}26`,
        color: accent,
        border: `1px solid ${accent}66`,
      }}
    >
      {children}
    </button>
  );
}

function SecondaryBtn({
  onClick, children,
}: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors"
      style={{
        backgroundColor: "rgba(255,255,255,0.04)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </button>
  );
}

