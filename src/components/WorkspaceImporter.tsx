"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Brain,
  Calendar,
  Database,
  Download,
  FolderOpen,
  KeySquare,
  Loader2,
  Sparkles,
  XCircle,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  restartGatewayClient,
  getAutoRestartPref,
  type ClientRestartResult,
} from "@/lib/restart-gateway-client";

interface WorkspaceStats {
  exists: boolean;
  totalFiles: number;
  totalBytes: number;
  topDirs: string[];
  hasMemory: boolean;
  hasSkills: boolean;
  hasSessions: boolean;
  hasAuth: boolean;
  lastModified: string | null;
}

interface WorkspaceInfo {
  relativePath: string;
  absolutePath: string;
  folderName: string;
  ownerAgentId: string | null;
  stats: WorkspaceStats;
}

interface Props {
  /** Id of the agent being edited (target of the import) */
  agentId: string;
  /** Path stored in agent.workspace (the destination) */
  currentWorkspace: string;
  /** Called after a successful import so the parent can re-fetch */
  onImported?: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAgo(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days > 7) return d.toLocaleDateString("pt-BR");
  if (days >= 1) return `há ${days}d`;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 1) return `há ${hours}h`;
  return "há poucos minutos";
}

export function WorkspaceImporter({ agentId, currentWorkspace, onImported }: Props) {
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    source: string;
    filesCopied: number;
    filesSkipped: number;
    bytesCopied: number;
    errorsCount: number;
  } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<ClientRestartResult | null>(null);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/workspaces", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Surface only workspaces that:
   *   - are NOT the current agent's workspace
   *   - have at least one file
   *   - are EITHER orphan (no owner) OR belong to a different agent
   * Sort by size (most data first).
   */
  const candidates = useMemo(() => {
    return workspaces
      .filter((w) => w.relativePath !== currentWorkspace && w.stats.totalFiles > 0)
      .sort((a, b) => b.stats.totalBytes - a.stats.totalBytes);
  }, [workspaces, currentWorkspace]);

  const runImport = async (source: WorkspaceInfo, overwrite: boolean) => {
    setImporting(source.relativePath);
    setImportResult(null);
    setRestartResult(null);
    setConfirmingOverwrite(null);
    try {
      const res = await fetch("/api/agents/workspaces/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          sourceWorkspace: source.relativePath,
          overwrite,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setImportResult({
        source: source.folderName,
        filesCopied: data.filesCopied || 0,
        filesSkipped: data.filesSkipped || 0,
        bytesCopied: data.bytesCopied || 0,
        errorsCount: Array.isArray(data.errors) ? data.errors.length : 0,
      });
      // Auto-restart so the daemon re-reads everything (memory, skills, sessions)
      if (getAutoRestartPref()) {
        setRestarting(true);
        const result = await restartGatewayClient();
        setRestartResult(result);
        setRestarting(false);
      }
      await load();
      onImported?.();
    } catch (e) {
      setImportResult({
        source: source.folderName,
        filesCopied: 0,
        filesSkipped: 0,
        bytesCopied: 0,
        errorsCount: 1,
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
  };

  return (
    <div
      className="rounded-lg p-3 mt-3"
      style={{
        backgroundColor: "rgba(96, 165, 250, 0.06)",
        border: "1px solid rgba(96, 165, 250, 0.25)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Archive className="w-4 h-4" style={{ color: "#60a5fa" }} />
        <h4 className="font-bold text-xs uppercase tracking-wider" style={{ color: "#60a5fa" }}>
          Importar memória de outra workspace
        </h4>
      </div>
      <p className="text-[11px] mb-3" style={{ color: "var(--text-muted)" }}>
        Copia memórias, skills, sessões e auth de outra pasta em{" "}
        <code className="px-1 rounded bg-black/30">~/.openclaw/workspace/</code> pra dentro de{" "}
        <code className="px-1 rounded bg-black/30">{currentWorkspace}</code>. Útil quando o agente
        ficou com workspace vazia ou pra herdar dados de um agente anterior.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" />
          Procurando workspaces…
        </div>
      )}

      {error && !importing && (
        <div
          className="flex items-start gap-2 text-xs p-2 rounded"
          style={{
            backgroundColor: "rgba(239,68,68,0.1)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.3)",
          }}
        >
          <XCircle className="w-3.5 h-3.5 mt-0.5" />
          {error}
        </div>
      )}

      {!loading && candidates.length === 0 && !error && (
        <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
          Nenhuma outra workspace com dados encontrada. Você está iniciando do zero.
        </p>
      )}

      <div className="space-y-2">
        {candidates.map((w) => {
          const isOrphan = !w.ownerAgentId;
          const isImporting = importing === w.relativePath;
          return (
            <div
              key={w.relativePath}
              className="rounded-lg p-2.5"
              style={{
                backgroundColor: "rgba(0,0,0,0.25)",
                border: `1px solid ${isOrphan ? "rgba(96, 165, 250, 0.4)" : "var(--border)"}`,
              }}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <FolderOpen className="w-3.5 h-3.5" style={{ color: isOrphan ? "#60a5fa" : "var(--text-muted)" }} />
                    <code className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>
                      {w.folderName}
                    </code>
                    {isOrphan ? (
                      <span
                        className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: "rgba(96, 165, 250, 0.15)",
                          color: "#60a5fa",
                        }}
                      >
                        órfã (sem dono)
                      </span>
                    ) : (
                      <span
                        className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: "rgba(234, 179, 8, 0.15)",
                          color: "#facc15",
                        }}
                      >
                        usada por &ldquo;{w.ownerAgentId}&rdquo;
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap text-[11px]" style={{ color: "var(--text-muted)" }}>
                    <span className="flex items-center gap-1">
                      <Database className="w-3 h-3" />
                      {w.stats.totalFiles} arq · {formatBytes(w.stats.totalBytes)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatAgo(w.stats.lastModified)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {w.stats.hasMemory && <DataChip icon={Brain} label="memória" color="#a78bfa" />}
                    {w.stats.hasSkills && <DataChip icon={Sparkles} label="skills" color="#fbbf24" />}
                    {w.stats.hasSessions && <DataChip icon={Database} label="sessões" color="#34d399" />}
                    {w.stats.hasAuth && <DataChip icon={KeySquare} label="auth" color="#f87171" />}
                    {w.stats.topDirs
                      .filter((d) => !["memory", "memories", "skills", "sessions", "auth", "auth-state"].includes(d.toLowerCase()))
                      .slice(0, 4)
                      .map((d) => (
                        <span
                          key={d}
                          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                          style={{
                            backgroundColor: "rgba(255,255,255,0.04)",
                            color: "var(--text-muted)",
                            border: "1px solid var(--border)",
                          }}
                        >
                          {d}
                        </span>
                      ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => runImport(w, false)}
                    disabled={isImporting || !!importing}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium disabled:opacity-40"
                    style={{
                      backgroundColor: "rgba(96, 165, 250, 0.2)",
                      color: "#93c5fd",
                      border: "1px solid rgba(96, 165, 250, 0.4)",
                    }}
                  >
                    {isImporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                    {isImporting ? "Importando…" : "Importar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingOverwrite(w.relativePath)}
                    disabled={isImporting || !!importing}
                    className="text-[10px] underline disabled:opacity-40"
                    style={{ color: "var(--text-muted)" }}
                    title="Sobrescreve arquivos existentes no destino (cuidado)"
                  >
                    importar com overwrite
                  </button>
                </div>
              </div>
              {confirmingOverwrite === w.relativePath && (
                <div
                  className="mt-2 p-2 rounded text-[11px] flex flex-col gap-1.5"
                  style={{
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                  }}
                >
                  <span style={{ color: "#fca5a5" }}>
                    ⚠ Overwrite vai SOBRESCREVER arquivos que já existem no destino. Confirma?
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => runImport(w, true)}
                      className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{
                        backgroundColor: "rgba(239, 68, 68, 0.3)",
                        color: "#fca5a5",
                        border: "1px solid rgba(239, 68, 68, 0.5)",
                      }}
                    >
                      Sim, sobrescrever
                    </button>
                    <button
                      onClick={() => setConfirmingOverwrite(null)}
                      className="px-2 py-0.5 rounded text-[10px]"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {importResult && (
        <div
          className="mt-3 p-2.5 rounded-lg text-xs flex items-start gap-2"
          style={{
            backgroundColor: importResult.errorsCount > 0 ? "rgba(234,179,8,0.1)" : "rgba(16, 185, 129, 0.1)",
            border: `1px solid ${importResult.errorsCount > 0 ? "rgba(234,179,8,0.3)" : "rgba(16, 185, 129, 0.3)"}`,
            color: importResult.errorsCount > 0 ? "#fde68a" : "#34d399",
          }}
        >
          {importResult.errorsCount > 0 ? (
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          )}
          <div>
            Importado de <b>{importResult.source}</b>: {importResult.filesCopied} novos arquivo(s),{" "}
            {importResult.filesSkipped} já existiam{" "}
            {importResult.bytesCopied > 0 && `· ${formatBytes(importResult.bytesCopied)}`}
            {importResult.errorsCount > 0 && ` · ${importResult.errorsCount} erro(s)`}.
            {restarting && (
              <div className="mt-1 flex items-center gap-1.5" style={{ color: "var(--text-secondary)" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                Reiniciando gateway pra carregar os novos arquivos…
              </div>
            )}
            {restartResult && (
              <div className="mt-1" style={{ color: restartResult.success ? "#34d399" : "#fca5a5" }}>
                {restartResult.success
                  ? `✓ Gateway reiniciado em ${(restartResult.durationMs / 1000).toFixed(1)}s — memória já está ativa`
                  : `⚠ Restart falhou: ${restartResult.error?.slice(0, 100) || "erro desconhecido"}`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DataChip({
  icon: Icon,
  label,
  color,
}: {
  icon: typeof Brain;
  label: string;
  color: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium"
      style={{
        backgroundColor: `${color}1A`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}
