"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";
import {
  FileCog,
  RefreshCw,
  Wand2,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Radio,
} from "lucide-react";

interface FileAnalysis {
  hasBase: boolean;
  baseChars: number;
  customChars: number;
  totalChars: number;
  tokensEstimate: number;
}
interface FilePreview {
  file: string;
  before: string;
  after: string;
  changed: boolean;
  exists: boolean;
  analysisBefore: FileAnalysis;
  analysisAfter: FileAnalysis;
}
interface ChannelContext {
  telegram: boolean;
  whatsapp: boolean;
  discord: boolean;
  slack: boolean;
  web: boolean;
  active: string[];
}
interface Preview {
  agentId: string;
  agentName: string;
  workspace: string;
  channels: ChannelContext;
  files: FilePreview[];
}
interface AgentOption {
  id: string;
  name?: string;
}

const card = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg, 12px)",
  padding: "1rem",
} as const;

export default function AgentInstructionsPage() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("main");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isMobile = useIsMobile();

  // Populate the agent selector. Tolerates either an array or {agents:[...]}.
  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        const list: AgentOption[] = Array.isArray(d) ? d : d.agents || d.list || [];
        if (list.length) setAgents(list.map((a) => ({ id: a.id, name: a.name })));
      })
      .catch(() => setAgents([]));
  }, []);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setStatus(null);
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(id)}/instructions`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Falha ao carregar");
      setPreview(d);
    } catch (e) {
      setPreview(null);
      setStatus({ kind: "err", msg: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(agentId);
  }, [agentId, load]);

  const apply = async () => {
    if (!preview) return;
    const changedCount = preview.files.filter((f) => f.changed).length;
    if (!changedCount) {
      setStatus({ kind: "ok", msg: "Nada a aplicar — já está em dia." });
      return;
    }
    if (
      !window.confirm(
        `Aplicar a base otimizada em ${changedCount} arquivo(s) do agente "${preview.agentName}"? ` +
          `Um backup é criado antes. Conteúdo fora dos marcadores é preservado.`,
      )
    )
      return;
    setApplying(true);
    setStatus(null);
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Falha ao aplicar");
      setStatus({
        kind: "ok",
        msg: `Aplicado em ${d.written.length} arquivo(s). Backup: ${d.backupDir || "—"}. O agente usa a nova versão na próxima mensagem (sem restart).`,
      });
      await load(agentId);
    } catch (e) {
      setStatus({ kind: "err", msg: (e as Error).message });
    } finally {
      setApplying(false);
    }
  };

  const totalBefore = preview?.files.reduce((s, f) => s + f.analysisBefore.tokensEstimate, 0) ?? 0;
  const totalAfter = preview?.files.reduce((s, f) => s + f.analysisAfter.tokensEstimate, 0) ?? 0;
  const changedCount = preview?.files.filter((f) => f.changed).length ?? 0;

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1000, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <FileCog className="w-7 h-7" style={{ color: "var(--accent)" }} />
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.5rem",
            fontWeight: 700,
            color: "var(--text-primary)",
          }}
        >
          Arquivos de Instrução
        </h1>
      </div>
      <p style={{ color: "var(--text-secondary)", marginBottom: 20, fontSize: ".9rem" }}>
        O AtlasDeck gerencia um <strong>bloco base</strong> otimizado e ciente dos seus canais em{" "}
        <code>AGENTS.md</code>, <code>SOUL.md</code> e <code>TOOLS.md</code>. Tudo que você escrever{" "}
        <strong>fora dos marcadores</strong> é preservado.
      </p>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ color: "var(--text-secondary)", fontSize: ".85rem" }}>Agente:</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          style={{
            backgroundColor: "var(--card)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
          }}
        >
          {(agents.length ? agents : [{ id: "main", name: "main" }]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ? `${a.name} (${a.id})` : a.id}
            </option>
          ))}
        </select>
        <button onClick={() => load(agentId)} disabled={loading} style={btn(false)}>
          <RefreshCw className="w-4 h-4" style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />
          Recarregar
        </button>
        <button onClick={apply} disabled={applying || loading || !changedCount} style={btn(true, !changedCount)}>
          <Wand2 className="w-4 h-4" />
          {applying ? "Aplicando..." : `Aplicar otimização${changedCount ? ` (${changedCount})` : ""}`}
        </button>
      </div>

      {/* Status */}
      {status && (
        <div
          style={{
            ...card,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: 16,
            borderColor: status.kind === "ok" ? "var(--positive, #2ecc71)" : "var(--negative, #e74c3c)",
          }}
        >
          {status.kind === "ok" ? (
            <Check className="w-5 h-5" style={{ color: "var(--positive, #2ecc71)", flexShrink: 0 }} />
          ) : (
            <AlertTriangle className="w-5 h-5" style={{ color: "var(--negative, #e74c3c)", flexShrink: 0 }} />
          )}
          <span style={{ color: "var(--text-primary)", fontSize: ".9rem" }}>{status.msg}</span>
        </div>
      )}

      {preview && (
        <>
          {/* Channels + token summary */}
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Radio className="w-4 h-4" style={{ color: "var(--accent)" }} />
              <span style={{ color: "var(--text-secondary)", fontSize: ".85rem" }}>
                Canais detectados (do openclaw.json):
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {preview.channels.active.map((c) => (
                <span key={c} style={chip}>
                  {c}
                </span>
              ))}
            </div>
            <div style={{ color: "var(--text-secondary)", fontSize: ".85rem" }}>
              Tokens (estimados) nos 3 arquivos:{" "}
              <strong style={{ color: "var(--text-primary)" }}>{totalBefore}</strong> →{" "}
              <strong style={{ color: totalAfter <= totalBefore ? "var(--positive, #2ecc71)" : "var(--warning, #f39c12)" }}>
                {totalAfter}
              </strong>{" "}
              <span style={{ opacity: 0.7 }}>
                ({totalAfter - totalBefore >= 0 ? "+" : ""}
                {totalAfter - totalBefore})
              </span>
              <span style={{ opacity: 0.6, marginLeft: 8 }}>
                · workspace: <code>{preview.workspace}</code>
              </span>
            </div>
          </div>

          {/* Per-file */}
          {preview.files.map((f) => {
            const isOpen = !!expanded[f.file];
            return (
              <div key={f.file} style={{ ...card, marginBottom: 12 }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flexWrap: "wrap" }}
                  onClick={() => setExpanded((s) => ({ ...s, [f.file]: !s[f.file] }))}
                >
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <code style={{ color: "var(--text-primary)", fontWeight: 600 }}>{f.file}</code>
                  {!f.exists && <span style={{ ...chip, opacity: 0.7 }}>novo</span>}
                  {f.changed ? (
                    <span style={{ ...chip, borderColor: "var(--warning, #f39c12)", color: "var(--warning, #f39c12)" }}>
                      muda
                    </span>
                  ) : (
                    <span style={{ ...chip, borderColor: "var(--positive, #2ecc71)", color: "var(--positive, #2ecc71)" }}>
                      em dia
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: ".8rem" }}>
                    ~{f.analysisBefore.tokensEstimate} → ~{f.analysisAfter.tokensEstimate} tok · custom preservado:{" "}
                    {f.analysisAfter.customChars} chars
                  </span>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={colHead}>Antes</div>
                      <pre style={pre}>{f.before || "(arquivo vazio / inexistente)"}</pre>
                    </div>
                    <div>
                      <div style={colHead}>Depois (proposto)</div>
                      <pre style={{ ...pre, borderColor: f.changed ? "var(--warning, #f39c12)" : "var(--border)" }}>
                        {f.after}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

const chip = {
  fontSize: ".75rem",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
} as const;

const colHead = {
  fontSize: ".75rem",
  color: "var(--text-secondary)",
  marginBottom: 4,
  textTransform: "uppercase" as const,
  letterSpacing: ".5px",
};

const pre = {
  margin: 0,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: ".72rem",
  lineHeight: 1.5,
  color: "var(--text-primary)",
  backgroundColor: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 10,
  maxHeight: 360,
  overflow: "auto",
};

function btn(primary: boolean, disabled = false) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontSize: ".85rem",
    fontWeight: 600,
    backgroundColor: primary ? "var(--accent)" : "var(--card)",
    color: primary ? "#fff" : "var(--text-primary)",
  } as const;
}
