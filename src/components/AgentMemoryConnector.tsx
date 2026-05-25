"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  BookOpen,
  Sparkles,
  Database,
  MessageSquare,
  Link2,
  Link2Off,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import {
  restartGatewayClient,
  getAutoRestartPref,
  type ClientRestartResult,
} from "@/lib/restart-gateway-client";

interface SkillFile {
  name: string;
  path: string;
  summary?: string;
  bytes: number;
}

interface Resources {
  agentId: string;
  agentDir: string;
  shared: {
    memoryDb: { exists: boolean; path: string; entryCount?: number; agentsRepresented?: string[]; bytes?: number };
    knowledgeBase: { exists: boolean; path: string; sections?: string[]; bytes?: number };
    skills: { exists: boolean; path: string; files: SkillFile[]; count: number };
  };
  perAgent: {
    instructionsMd: { exists: boolean; path: string; bytes: number; hasAppendix: boolean; appendixSize: number };
    sessions: { exists: boolean; path: string; count: number; latest: string | null };
  };
  hasAnyResource: boolean;
  isConnected: boolean;
  previewAppendix: string;
  previewLines: number;
}

interface Props {
  agentId: string;
  /** Refresh callback for parent (e.g. re-fetch agents list after connect/disconnect) */
  onChanged?: () => void;
}

function formatBytes(n: number | undefined): string {
  if (!n && n !== 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function AgentMemoryConnector({ agentId, onChanged }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Resources | null>(null);
  const [acting, setActing] = useState<"attach" | "detach" | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<ClientRestartResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/memory-connect?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doAttach = async () => {
    setActing("attach");
    setResult(null);
    setRestartResult(null);
    try {
      const res = await fetch("/api/agents/memory-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult({ kind: "ok", text: json.message });
      if (getAutoRestartPref()) {
        setRestarting(true);
        const r = await restartGatewayClient();
        setRestartResult(r);
        setRestarting(false);
      }
      await load();
      onChanged?.();
    } catch (e) {
      setResult({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setActing(null);
    }
  };

  const doDetach = async () => {
    if (!confirm("Remover o apêndice de memória? O Jarvis volta a usar só o instructions.md original.")) return;
    setActing("detach");
    setResult(null);
    setRestartResult(null);
    try {
      const res = await fetch(`/api/agents/memory-connect?agentId=${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult({ kind: "ok", text: json.message });
      if (getAutoRestartPref()) {
        setRestarting(true);
        const r = await restartGatewayClient();
        setRestartResult(r);
        setRestarting(false);
      }
      await load();
      onChanged?.();
    } catch (e) {
      setResult({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setActing(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="mt-3 p-3 rounded-lg flex items-center gap-2 text-xs" style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Detectando recursos de memória custom…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 p-3 rounded-lg flex items-start gap-2 text-xs" style={{ backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5" }}>
        <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div className="flex-1">
          {error}
          <button onClick={load} className="ml-2 underline">tentar de novo</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // No custom resources detected → silent (don't pollute the modal)
  if (!data.hasAnyResource) {
    return (
      <div className="mt-3 p-3 rounded-lg flex items-start gap-2 text-xs" style={{ backgroundColor: "rgba(0,0,0,0.2)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
        <Brain className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Nenhum recurso de memória custom detectado em <code>~/.openclaw/agents/</code>.
          (Se você acabou de instalar o sistema multi-agente Python, recarregue.)
        </span>
      </div>
    );
  }

  const accent = data.isConnected ? "#34d399" : "#a78bfa";

  return (
    <div
      className="mt-3 rounded-lg p-3"
      style={{
        backgroundColor: data.isConnected ? "rgba(16, 185, 129, 0.06)" : "rgba(139, 92, 246, 0.06)",
        border: `1px solid ${data.isConnected ? "rgba(16, 185, 129, 0.3)" : "rgba(139, 92, 246, 0.3)"}`,
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4" style={{ color: accent }} />
          <h4 className="font-bold text-xs uppercase tracking-wider" style={{ color: accent }}>
            Memória custom {data.isConnected ? "(CONECTADA)" : "(NÃO CONECTADA)"}
          </h4>
        </div>
        <button
          onClick={load}
          disabled={loading || acting !== null}
          className="p-1 rounded hover:bg-white/5 disabled:opacity-30"
          title="Re-detectar recursos"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      <p className="text-[11px] mb-2.5" style={{ color: "var(--text-muted)" }}>
        Quando conectada, o Jarvis recebe instruções no system prompt pra <b>consultar memory engine + knowledge base + skills + sessões antigas</b> via <code>bash</code> antes de responder.
      </p>

      {/* Resource grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ResourceChip
          icon={Database}
          color="#a78bfa"
          label="Memory engine"
          present={data.shared.memoryDb.exists}
          detail={
            data.shared.memoryDb.exists
              ? `${data.shared.memoryDb.entryCount ?? "?"} entries · ${formatBytes(data.shared.memoryDb.bytes)}`
              : "agent_memory.db não encontrado"
          }
          subDetail={data.shared.memoryDb.agentsRepresented?.length ? `Agentes: ${data.shared.memoryDb.agentsRepresented.join(", ")}` : undefined}
        />
        <ResourceChip
          icon={BookOpen}
          color="#60a5fa"
          label="Knowledge base"
          present={data.shared.knowledgeBase.exists}
          detail={
            data.shared.knowledgeBase.exists
              ? `${data.shared.knowledgeBase.sections?.length ?? 0} seções`
              : "knowledge_base.json não encontrado"
          }
          subDetail={data.shared.knowledgeBase.sections?.length ? data.shared.knowledgeBase.sections.slice(0, 4).join(" · ") + (data.shared.knowledgeBase.sections.length > 4 ? "…" : "") : undefined}
        />
        <ResourceChip
          icon={Sparkles}
          color="#fbbf24"
          label="Skills"
          present={data.shared.skills.count > 0}
          detail={data.shared.skills.count > 0 ? `${data.shared.skills.count} arquivo(s) .md` : "skills/ vazio"}
          subDetail={data.shared.skills.files.slice(0, 3).map((f) => f.name.replace(/\.md$/, "")).join(" · ") + (data.shared.skills.count > 3 ? "…" : "")}
        />
        <ResourceChip
          icon={MessageSquare}
          color="#34d399"
          label="Sessions antigas"
          present={data.perAgent.sessions.count > 0}
          detail={
            data.perAgent.sessions.count > 0
              ? `${data.perAgent.sessions.count} transcripts`
              : "sessions/ vazio"
          }
          subDetail={data.perAgent.sessions.latest ? `última: ${new Date(data.perAgent.sessions.latest).toLocaleDateString("pt-BR")}` : undefined}
        />
      </div>

      {/* instructions.md status */}
      <div className="text-[11px] mb-3 flex items-start gap-2" style={{ color: "var(--text-muted)" }}>
        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: data.perAgent.instructionsMd.exists ? "#34d399" : "#fca5a5" }} />
        <div>
          <code>{data.perAgent.instructionsMd.path}</code>
          {data.perAgent.instructionsMd.exists ? (
            <>
              {" "}— {formatBytes(data.perAgent.instructionsMd.bytes)}
              {data.isConnected && <> · apêndice atual: {formatBytes(data.perAgent.instructionsMd.appendixSize)}</>}
            </>
          ) : (
            <> — arquivo será criado ao conectar</>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {!data.isConnected ? (
          <button
            type="button"
            onClick={doAttach}
            disabled={acting !== null || restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
            style={{
              backgroundColor: "rgba(139, 92, 246, 0.25)",
              color: "#c4b5fd",
              border: "1px solid rgba(139, 92, 246, 0.5)",
            }}
          >
            {acting === "attach" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            {acting === "attach" ? "Conectando…" : "Conectar memória custom ao Jarvis"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={doAttach}
              disabled={acting !== null || restarting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
              style={{
                backgroundColor: "rgba(96, 165, 250, 0.2)",
                color: "#93c5fd",
                border: "1px solid rgba(96, 165, 250, 0.4)",
              }}
              title="Re-detecta recursos atuais e regenera o apêndice"
            >
              {acting === "attach" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {acting === "attach" ? "Atualizando…" : "Atualizar apêndice"}
            </button>
            <button
              type="button"
              onClick={doDetach}
              disabled={acting !== null || restarting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-40"
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                color: "#fca5a5",
                border: "1px solid rgba(239, 68, 68, 0.3)",
              }}
            >
              {acting === "detach" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2Off className="w-3.5 h-3.5" />}
              {acting === "detach" ? "Removendo…" : "Desconectar"}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          disabled={!data.previewAppendix}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
          style={{
            backgroundColor: "rgba(255,255,255,0.04)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
        >
          {showPreview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Preview do apêndice ({data.previewLines} linhas)
        </button>
      </div>

      {result && (
        <div
          className="mt-2 p-2 rounded text-[11px] flex items-start gap-2"
          style={{
            backgroundColor: result.kind === "ok" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
            color: result.kind === "ok" ? "#34d399" : "#fca5a5",
            border: `1px solid ${result.kind === "ok" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
          }}
        >
          {result.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>{result.text}</span>
        </div>
      )}

      {restarting && (
        <div className="mt-2 p-2 rounded text-[11px] flex items-center gap-2" style={{ backgroundColor: "rgba(139, 92, 246, 0.08)", color: "var(--text-primary)", border: "1px solid rgba(139, 92, 246, 0.25)" }}>
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#a78bfa" }} />
          Reiniciando gateway pra aplicar…
        </div>
      )}
      {restartResult && !restarting && (
        <div
          className="mt-2 p-2 rounded text-[11px] flex items-start gap-2"
          style={{
            backgroundColor: restartResult.success ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
            color: restartResult.success ? "#34d399" : "#fca5a5",
            border: `1px solid ${restartResult.success ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
          }}
        >
          {restartResult.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>
            {restartResult.success
              ? `Gateway reiniciado em ${(restartResult.durationMs / 1000).toFixed(1)}s — Jarvis já está usando a nova memória`
              : `Falha no restart: ${restartResult.error?.slice(0, 120) || "desconhecido"}`}
          </span>
        </div>
      )}

      {showPreview && data.previewAppendix && (
        <pre
          className="mt-2 p-2 rounded text-[10px] font-mono whitespace-pre-wrap overflow-auto"
          style={{
            backgroundColor: "rgba(0,0,0,0.4)",
            color: "var(--text-primary)",
            maxHeight: 320,
            border: "1px solid var(--border)",
          }}
        >
          {data.previewAppendix}
        </pre>
      )}
    </div>
  );
}

function ResourceChip({
  icon: Icon, color, label, present, detail, subDetail,
}: {
  icon: typeof Brain; color: string; label: string; present: boolean;
  detail: string; subDetail?: string;
}) {
  const tint = present ? color : "var(--text-muted)";
  return (
    <div
      className="rounded p-2 flex flex-col gap-0.5"
      style={{
        backgroundColor: present ? `${color}10` : "rgba(0,0,0,0.2)",
        border: `1px solid ${present ? `${color}30` : "var(--border)"}`,
        opacity: present ? 1 : 0.5,
      }}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3" style={{ color: tint }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: tint }}>{label}</span>
      </div>
      <div className="text-[10px]" style={{ color: present ? "var(--text-primary)" : "var(--text-muted)" }}>{detail}</div>
      {subDetail && (
        <div className="text-[10px] truncate font-mono" style={{ color: "var(--text-muted)" }} title={subDetail}>
          {subDetail}
        </div>
      )}
    </div>
  );
}
