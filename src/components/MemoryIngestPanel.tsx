"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database,
  DownloadCloud,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Clock,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";

interface Preview {
  agentId: string;
  sessions: {
    count: number;
    totalBytes: number;
    latest: string | null;
    oldest: string | null;
    sample: Array<{ sessionId: string; bytes: number; modified: string }>;
  };
  memoryDb: {
    exists: boolean;
    path: string;
    totalEntries: number;
    sessionImportEntries: number;
  };
}

interface IngestLogEntry {
  type: "init" | "start" | "parsed" | "inserted" | "skipped" | "error" | "done";
  index?: number;
  total?: number;
  sessionId?: string;
  detail?: string;
  summary?: {
    totalFiles: number;
    inserted: number;
    skipped: number;
    errors: number;
    elapsedMs: number;
  };
}

interface Props {
  agentId: string;
  onIngested?: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAgo(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 30) return d.toLocaleDateString("pt-BR");
  if (days >= 1) return `há ${days}d`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `há ${hours}h`;
  return "há poucos min";
}

export function MemoryIngestPanel({ agentId, onIngested }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; lastSessionId?: string } | null>(null);
  const [result, setResult] = useState<IngestLogEntry["summary"] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<IngestLogEntry[]>([]);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/memory-ingest?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void loadPreview(); }, [loadPreview]);

  const runIngest = async (dryRun: boolean) => {
    setIngesting(true);
    setResult(null);
    setLog([]);
    setProgress(null);
    try {
      const res = await fetch("/api/agents/memory-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, dryRun, backup: true }),
      });
      if (!res.body) throw new Error("Sem corpo de resposta");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!chunk.startsWith("data: ")) continue;
          try {
            const ev: IngestLogEntry = JSON.parse(chunk.slice(6));
            setLog((l) => [...l.slice(-200), ev]); // keep last 200
            if (ev.type === "parsed" || ev.type === "inserted" || ev.type === "skipped" || ev.type === "error") {
              if (ev.index && ev.total) {
                setProgress({ current: ev.index, total: ev.total, lastSessionId: ev.sessionId });
              }
            }
            if (ev.type === "done") {
              setResult(ev.summary || null);
            }
          } catch {}
        }
      }
      await loadPreview();
      onIngested?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  };

  if (loading && !preview) {
    return (
      <div className="mt-3 p-3 rounded-lg flex items-center gap-2 text-xs" style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Verificando memória e sessões…
      </div>
    );
  }

  if (error && !preview) {
    return (
      <div className="mt-3 p-3 rounded-lg flex items-start gap-2 text-xs" style={{ backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5" }}>
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div className="flex-1">{error} <button onClick={loadPreview} className="ml-2 underline">retry</button></div>
      </div>
    );
  }

  if (!preview) return null;

  // Hide panel entirely if there's no DB AND no sessions (nothing to do)
  if (!preview.memoryDb.exists && preview.sessions.count === 0) return null;

  const pct = progress ? Math.round((progress.current / progress.total) * 100) : 0;
  const sessionsToIngest = preview.sessions.count - preview.memoryDb.sessionImportEntries;

  return (
    <div
      className="mt-3 rounded-lg p-3"
      style={{
        backgroundColor: "rgba(96, 165, 250, 0.06)",
        border: "1px solid rgba(96, 165, 250, 0.3)",
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4" style={{ color: "#60a5fa" }} />
          <h4 className="font-bold text-xs uppercase tracking-wider" style={{ color: "#60a5fa" }}>
            Indexar sessões antigas como memória searchable
          </h4>
        </div>
        <button
          onClick={loadPreview}
          disabled={loading || ingesting}
          className="p-1 rounded hover:bg-white/5 disabled:opacity-30"
          title="Re-verificar contagens"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      <p className="text-[11px] mb-3" style={{ color: "var(--text-muted)" }}>
        Cada session vira UMA entrada em <code className="text-[10px] bg-black/30 px-1 rounded">agent_memory.db</code> (categoria{" "}
        <code className="text-[10px] bg-black/30 px-1 rounded">session-import</code>) com importance ranqueado por recência + tamanho.
        Idempotente — re-rodar não duplica. O Jarvis então faz <code className="text-[10px] bg-black/30 px-1 rounded">SELECT</code> em vez de grep.
      </p>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <StatCard
          icon={FileText}
          color="#60a5fa"
          label="Sessions disponíveis"
          value={preview.sessions.count.toString()}
          sub={`${formatBytes(preview.sessions.totalBytes)} total`}
        />
        <StatCard
          icon={Clock}
          color="#fbbf24"
          label="Mais antiga / recente"
          value={preview.sessions.oldest ? `${formatAgo(preview.sessions.oldest)}` : "—"}
          sub={preview.sessions.latest ? `→ ${formatAgo(preview.sessions.latest)}` : ""}
        />
        <StatCard
          icon={Database}
          color={preview.memoryDb.exists ? "#34d399" : "#fca5a5"}
          label="agent_memory.db"
          value={preview.memoryDb.exists ? `${preview.memoryDb.totalEntries} entries` : "não existe"}
          sub={preview.memoryDb.exists ? `${preview.memoryDb.sessionImportEntries} de session-import` : preview.memoryDb.path}
        />
        <StatCard
          icon={DownloadCloud}
          color="#a78bfa"
          label="Pendente de ingest"
          value={sessionsToIngest > 0 ? `${sessionsToIngest} session(s)` : "tudo importado"}
          sub={sessionsToIngest > 0 ? "Re-import é seguro (UPSERT)" : "Re-run só atualiza importance"}
        />
      </div>

      {!preview.memoryDb.exists && (
        <div className="mb-3 p-2 rounded text-[11px] flex items-start gap-2" style={{ backgroundColor: "rgba(239,68,68,0.08)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" }}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <code>agent_memory.db</code> não existe em <code>~/.openclaw/agents/</code>. Crie primeiro rodando o sistema Python custom
            (<code>memory_engine.py</code>) ou execute manualmente: <code className="bg-black/30 px-1 rounded">sqlite3 ~/.openclaw/agents/agent_memory.db &lt; schema.sql</code>
          </span>
        </div>
      )}

      {/* Progress */}
      {ingesting && progress && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>
            <span>Processando {progress.current}/{progress.total}{progress.lastSessionId && ` · ${progress.lastSessionId.slice(0, 8)}…`}</span>
            <span>{pct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
            <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: "#60a5fa" }} />
          </div>
        </div>
      )}

      {/* Result */}
      {result && !ingesting && (
        <div className="mb-3 p-2 rounded text-xs flex items-start gap-2" style={{ backgroundColor: result.errors > 0 ? "rgba(234,179,8,0.1)" : "rgba(16,185,129,0.1)", color: result.errors > 0 ? "#fde68a" : "#34d399", border: `1px solid ${result.errors > 0 ? "rgba(234,179,8,0.3)" : "rgba(16,185,129,0.3)"}` }}>
          {result.errors > 0 ? <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <div className="flex-1">
            <b>{result.inserted}</b> session(s) importada(s) em {(result.elapsedMs / 1000).toFixed(1)}s.
            {result.skipped > 0 && <> {result.skipped} pulada(s) (sem mensagens extraíveis).</>}
            {result.errors > 0 && <> <span style={{ color: "#fca5a5" }}>{result.errors} erro(s) — ver log.</span></>}
            <div className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              Teste no Telegram: <i>&quot;jarvis, o que vc lembra sobre minha infra?&quot;</i> — ele agora vai buscar no DB.
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => runIngest(false)}
          disabled={ingesting || !preview.memoryDb.exists}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
          style={{
            backgroundColor: "rgba(96, 165, 250, 0.25)",
            color: "#93c5fd",
            border: "1px solid rgba(96, 165, 250, 0.5)",
          }}
        >
          {ingesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadCloud className="w-3.5 h-3.5" />}
          {ingesting
            ? "Importando…"
            : preview.memoryDb.sessionImportEntries > 0
              ? "Re-importar (UPSERT)"
              : `Importar ${preview.sessions.count} session(s)`}
        </button>
        <button
          type="button"
          onClick={() => runIngest(true)}
          disabled={ingesting || !preview.memoryDb.exists}
          className="text-[11px] px-2 py-1.5 rounded-lg disabled:opacity-40"
          style={{
            backgroundColor: "rgba(255,255,255,0.04)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
          title="Conta o que seria importado sem escrever no DB"
        >
          Dry-run
        </button>
        {log.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="flex items-center gap-1 text-[11px] px-2 py-1.5 rounded"
            style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
          >
            {showLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Log ({log.length})
          </button>
        )}
      </div>

      {showLog && log.length > 0 && (
        <pre
          className="mt-2 p-2 rounded text-[10px] font-mono whitespace-pre-wrap overflow-auto"
          style={{
            backgroundColor: "rgba(0,0,0,0.4)",
            color: "var(--text-primary)",
            maxHeight: 240,
            border: "1px solid var(--border)",
          }}
        >
          {log.map((l, i) => {
            const prefix = l.type === "inserted" ? "✓" : l.type === "error" ? "✗" : l.type === "skipped" ? "—" : l.type === "done" ? "★" : "·";
            const idx = l.index && l.total ? ` [${l.index}/${l.total}]` : "";
            const sid = l.sessionId ? ` ${l.sessionId.slice(0, 8)}…` : "";
            const detail = l.detail ? ` · ${l.detail}` : "";
            return <div key={i}>{prefix} {l.type}{idx}{sid}{detail}</div>;
          })}
        </pre>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon, color, label, value, sub,
}: {
  icon: typeof Database; color: string; label: string; value: string; sub: string;
}) {
  return (
    <div
      className="rounded p-2"
      style={{
        backgroundColor: "rgba(0,0,0,0.25)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <Icon className="w-3 h-3" style={{ color }} />
        <span className="text-[10px] uppercase font-bold tracking-wider" style={{ color }}>{label}</span>
      </div>
      <div className="text-[12px] font-bold" style={{ color: "var(--text-primary)" }}>{value}</div>
      {sub && <div className="text-[10px] truncate" style={{ color: "var(--text-muted)" }} title={sub}>{sub}</div>}
    </div>
  );
}
