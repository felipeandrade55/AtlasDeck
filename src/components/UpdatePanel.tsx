"use client";

import { useState, useEffect, useRef } from "react";
import { Download, CheckCircle, AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import type { UpdateCheckResult, UpdateHistoryEntry, UpdatePhase } from "@/lib/update";

export function UpdatePanel() {
  const [status, setStatus] = useState<'loading' | 'uptodate' | 'available' | 'updating' | 'complete' | 'error'>('loading');
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [logs, setLogs] = useState<{line: string, timestamp: string}[]>([]);
  const [phases, setPhases] = useState<(UpdatePhase & {label: string})[]>([]);
  const [duration, setDuration] = useState(0);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchCheck = async (force = false) => {
    try {
      setStatus('loading');
      const res = await fetch(`/api/update/check${force ? '?force=1' : ''}`);
      if (!res.ok) throw new Error("Falha ao checar atualizações");
      const data: UpdateCheckResult = await res.json();
      setCheckResult(data);
      setStatus(data.hasUpdate ? 'available' : 'uptodate');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Erro desconhecido');
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/update/history');
      if (res.ok) {
        const data = await res.json();
        setHistory(data.updates || []);
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchCheck();
    fetchHistory();
    const interval = setInterval(() => fetchCheck(), 5 * 60 * 1000); // 5 min
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const startUpdate = async () => {
    setStatus('updating');
    setLogs([]);
    setPhases([
      { name: 'backup', label: 'Backup', status: 'pending' },
      { name: 'git-pull', label: 'Git Pull', status: 'pending' },
      { name: 'npm-install', label: 'Dependências', status: 'pending' },
      { name: 'build', label: 'Build', status: 'pending' },
      { name: 'pm2-restart', label: 'Restart', status: 'pending' },
      { name: 'health-check', label: 'Health Check', status: 'pending' },
    ]);
    setErrorMsg("");

    try {
      const response = await fetch('/api/update/start', { method: 'POST' });
      if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Falha ao iniciar atualização");
      }
      
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ') && currentEvent) {
            const data = JSON.parse(line.slice(6));
            
            if (currentEvent === 'log') {
              setLogs(prev => [...prev, data]);
            } else if (currentEvent === 'phase') {
              setPhases(prev => prev.map(p => p.name === data.name ? { ...p, ...data } : p));
            } else if (currentEvent === 'error') {
              setErrorMsg(data.message);
            } else if (currentEvent === 'complete') {
              setStatus(data.success ? 'complete' : 'error');
              setDuration(data.durationMs);
              fetchHistory();
            }
            
            currentEvent = '';
          }
        }
      }
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Erro de conexão SSE');
    }
  };

  const renderPhaseIcon = (s: string) => {
    switch (s) {
      case 'ok': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'fail': return <XCircle className="w-4 h-4 text-red-500" />;
      case 'running': return <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />;
      case 'skip': return <span className="text-gray-400 text-xs">pulado</span>;
      default: return <div className="w-3 h-3 rounded-full border-2 border-gray-500" />;
    }
  };

  return (
    <div className="card p-6" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", borderRadius: "12px" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--surface-elevated)" }}>
            <Download className="w-6 h-6" style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <h2 className="text-xl font-bold" style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}>
              Atualização do Sistema
            </h2>
            <p className="text-sm" style={{ fontFamily: "var(--font-body)", color: "var(--text-secondary)" }}>
              {checkResult ? `Versão atual: ${checkResult.localSha.slice(0, 7)}` : 'Verificando versão...'}
            </p>
          </div>
        </div>
        <button 
          onClick={() => fetchCheck(true)} 
          disabled={status === 'loading' || status === 'updating'}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
        >
          <RefreshCw className={`w-4 h-4 ${(status === 'loading' && !phases.length) ? 'animate-spin' : ''}`} />
          Verificar Agora
        </button>
      </div>

      {/* Body States */}
      <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        
        {/* Loading */}
        {status === 'loading' && !phases.length && (
          <div className="p-6 text-center" style={{ backgroundColor: "var(--surface)" }}>
            <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
            <p style={{ color: "var(--text-secondary)" }}>Verificando atualizações no GitHub...</p>
          </div>
        )}

        {/* Up to date */}
        {status === 'uptodate' && checkResult && (
          <div className="p-6 flex items-start gap-4" style={{ backgroundColor: "rgba(34, 197, 94, 0.1)" }}>
            <CheckCircle className="w-6 h-6 mt-1" style={{ color: "var(--positive)" }} />
            <div>
              <h3 className="text-lg font-bold mb-1" style={{ color: "var(--positive)", fontFamily: "var(--font-heading)" }}>
                Sistema atualizado
              </h3>
              <p className="text-sm mb-1" style={{ color: "var(--text-secondary)" }}>
                Você está rodando a última versão ({checkResult.localSha.slice(0, 7)}).
              </p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Última verificação: {new Date(checkResult.checkedAt).toLocaleTimeString()}
              </p>
            </div>
          </div>
        )}

        {/* Update Available */}
        {status === 'available' && checkResult && (
          <div className="p-6" style={{ backgroundColor: "rgba(234, 179, 8, 0.1)" }}>
            <div className="flex items-start gap-4 mb-4">
              <AlertTriangle className="w-6 h-6 mt-1" style={{ color: "var(--warning)" }} />
              <div className="flex-1">
                <h3 className="text-lg font-bold mb-1" style={{ color: "var(--warning)", fontFamily: "var(--font-heading)" }}>
                  Atualização disponível
                </h3>
                <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
                  {checkResult.behindBy} commits atrás · {checkResult.localSha.slice(0, 7)} → {checkResult.remoteSha.slice(0, 7)}
                </p>
                
                {checkResult.commits.length > 0 && (
                  <div className="rounded-lg p-3 mb-4 max-h-48 overflow-y-auto" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                    <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>Changelog Recente</h4>
                    <ul className="space-y-2">
                      {checkResult.commits.slice(0, 10).map(c => (
                        <li key={c.sha} className="text-sm flex gap-2">
                          <span className="text-gray-500 select-none">•</span>
                          <span>
                            <span style={{ color: "var(--text-primary)" }}>{c.message}</span>
                            <span style={{ color: "var(--text-muted)" }}> — {c.author}</span>
                          </span>
                        </li>
                      ))}
                      {checkResult.commits.length > 10 && (
                        <li className="text-xs text-center pt-2" style={{ color: "var(--text-muted)" }}>
                          ...e mais {checkResult.commits.length - 10} commits
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                
                <div className="flex gap-3">
                  <button onClick={startUpdate} className="px-5 py-2 rounded-lg font-bold text-sm transition-opacity hover:opacity-90" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
                    🚀 Atualizar Agora
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Updating State */}
        {status === 'updating' && (
          <div className="p-6" style={{ backgroundColor: "var(--surface)" }}>
            <h3 className="font-bold mb-4 flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
              <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--accent)" }} />
              Atualizando sistema...
            </h3>
            
            {/* Phase Progress */}
            <div className="flex flex-wrap gap-2 md:gap-4 mb-6">
              {phases.map((p, i) => (
                <div key={p.name} className="flex items-center gap-2 text-sm">
                  {renderPhaseIcon(p.status)}
                  <span style={{ color: p.status === 'running' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: p.status === 'running' ? 600 : 400 }}>
                    {p.label} {p.durationSec ? `(${p.durationSec}s)` : ''}
                  </span>
                  {i < phases.length - 1 && <span className="text-gray-600 mx-1">→</span>}
                </div>
              ))}
            </div>

            {/* Terminal */}
            <div className="rounded-lg p-4 h-64 overflow-y-auto" style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "#e6edf3", lineHeight: 1.5 }}>
                {logs.map((log, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
                    <span style={{ color: "#484f58", userSelect: "none" }}>{log.timestamp.split('T')[1].slice(0, 8)}</span>
                    <span>{log.line}</span>
                  </div>
                ))}
                <div className="animate-pulse text-gray-500 mt-2">●</div>
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        )}

        {/* Complete State */}
        {status === 'complete' && (
          <div className="p-6" style={{ backgroundColor: "rgba(34, 197, 94, 0.1)" }}>
            <div className="flex items-start gap-4">
              <CheckCircle className="w-6 h-6 mt-1" style={{ color: "var(--positive)" }} />
              <div className="flex-1">
                <h3 className="text-lg font-bold mb-1" style={{ color: "var(--positive)", fontFamily: "var(--font-heading)" }}>
                  Atualização concluída com sucesso!
                </h3>
                <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
                  Duração: {Math.round(duration / 1000)}s
                </p>
                <button onClick={() => setStatus('uptodate')} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}>
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {status === 'error' && (
          <div className="p-6" style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}>
            <div className="flex items-start gap-4">
              <XCircle className="w-6 h-6 mt-1 text-red-500" />
              <div className="flex-1">
                <h3 className="text-lg font-bold mb-1 text-red-500" style={{ fontFamily: "var(--font-heading)" }}>
                  Falha na atualização
                </h3>
                <div className="rounded bg-red-950/30 border border-red-900 p-3 mb-4 text-sm text-red-200">
                  {errorMsg}
                </div>
                <p className="text-sm text-red-300 mb-4">
                  Um backup foi criado antes da atualização e o sistema continua rodando a versão anterior. 
                  Verifique os logs ou o histórico para mais detalhes.
                </p>
                <button onClick={() => fetchCheck(true)} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-900/50 hover:bg-red-900 text-white transition-colors border border-red-700">
                  Tentar Novamente
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <button 
          onClick={() => setShowHistory(!showHistory)}
          className="text-sm font-medium flex items-center gap-2 transition-opacity hover:opacity-80" 
          style={{ color: "var(--text-secondary)" }}
        >
          {showHistory ? 'Ocultar Histórico' : 'Ver Histórico de Atualizações'}
        </button>
        
        {showHistory && (
          <div className="mt-4 overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
            <table className="w-full text-sm text-left">
              <thead className="bg-black/20" style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Versão</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Duração</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} className="border-t" style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}>
                    <td className="px-4 py-3">{new Date(h.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-xs">{h.fromSha} → {h.toSha}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${h.status === 'success' ? 'bg-green-900/30 text-green-400' : h.status === 'error' ? 'bg-red-900/30 text-red-400' : 'bg-blue-900/30 text-blue-400'}`}>
                        {h.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">{h.durationMs ? `${Math.round(h.durationMs/1000)}s` : '-'}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center italic text-gray-500">
                      Nenhuma atualização registrada.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
