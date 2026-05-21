"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Download,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type {
  UpdateCheckResult,
  UpdateHistoryEntry,
  UpdateLiveStatus,
  UpdatePhase,
} from "@/lib/update";

type Status = "loading" | "uptodate" | "available" | "updating" | "complete" | "error";

const PHASE_DEF: { name: string; label: string }[] = [
  { name: "backup", label: "Backup" },
  { name: "credentials", label: "Credenciais" },
  { name: "git-pull", label: "Git Pull" },
  { name: "npm-install", label: "Dependências" },
  { name: "build", label: "Build" },
  { name: "pm2-restart", label: "Restart PM2" },
  { name: "health-check", label: "Health Check" },
];

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function heartbeatAgeColor(ageMs: number): string {
  if (ageMs < 10_000) return "#22c55e"; // green: fresh
  if (ageMs < 30_000) return "#eab308"; // yellow: getting old
  return "#ef4444"; // red: stale, build may be dead
}

function formatHeartbeatAge(ageMs: number): string {
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s atrás`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s atrás`;
}

// Stuck threshold: build phase produces a heartbeat every 5s, but `next build`
// can monopolize the event loop for tens of seconds at a time. lastHeartbeat is
// merged with the artifact file mtime server-side (getActiveUpdate), so this
// only fires when the bash subprocess itself has actually stopped writing.
const STUCK_THRESHOLD_MS = 180_000;

export function UpdatePanel() {
  const [status, setStatus] = useState<Status>("loading");
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [logs, setLogs] = useState<{ line: string; timestamp: string }[]>([]);
  const [phases, setPhases] = useState<(UpdatePhase & { label: string })[]>([]);
  const [duration, setDuration] = useState(0);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [liveStatus, setLiveStatus] = useState<UpdateLiveStatus | null>(null);
  const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);
  const [elapsedTick, setElapsedTick] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const offsetsRef = useRef({ logOffset: 0, phaseOffset: 0 });
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchCheck = useCallback(async (force = false) => {
    try {
      setStatus((prev) => (prev === "updating" ? prev : "loading"));
      const res = await fetch(`/api/update/check${force ? "?force=1" : ""}`);
      if (!res.ok) throw new Error("Falha ao checar atualizações");
      const data: UpdateCheckResult = await res.json();
      setCheckResult(data);
      setStatus((prev) =>
        prev === "updating" ? prev : data.hasUpdate ? "available" : "uptodate"
      );
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Erro desconhecido");
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/update/history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.updates || []);
      }
    } catch {}
  }, []);

  const initPhases = useCallback((includeBackup: boolean) => {
    setPhases(
      PHASE_DEF.filter((p) => includeBackup || p.name !== "backup").map((p) => ({
        ...p,
        status: "pending",
      }))
    );
  }, []);

  const applyPhaseUpdate = useCallback(
    (incoming: { phase: string; status: UpdatePhase["status"]; durationSec?: number; ts?: string; error?: string }) => {
      setPhases((prev) =>
        prev.map((p) =>
          p.name === incoming.phase
            ? {
                ...p,
                status: incoming.status,
                durationSec: incoming.durationSec ?? p.durationSec,
                error: incoming.error ?? p.error,
              }
            : p
        )
      );
      if (incoming.status === "running") {
        setPhaseStartedAt(incoming.ts ? new Date(incoming.ts).getTime() : Date.now());
      }
    },
    []
  );

  // Conecta no SSE de stream; se cair, tenta reconectar com o offset atual.
  const connectStream = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {}
      eventSourceRef.current = null;
    }

    const params = new URLSearchParams({
      logOffset: String(offsetsRef.current.logOffset),
      phaseOffset: String(offsetsRef.current.phaseOffset),
    });
    const es = new EventSource(`/api/update/stream?${params.toString()}`);
    eventSourceRef.current = es;
    setReconnecting(false);

    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        liveStatus: UpdateLiveStatus | null;
        logOffset: number;
        phaseOffset: number;
      };
      if (data.liveStatus) {
        setLiveStatus(data.liveStatus);
        // Re-sync phases from snapshot
        setPhases((current) => {
          const merged = PHASE_DEF.map((def) => {
            const fromLive = data.liveStatus!.phases.find((p) => p.name === def.name);
            const fromCurrent = current.find((p) => p.name === def.name);
            return {
              ...def,
              status: fromLive?.status || fromCurrent?.status || ("pending" as UpdatePhase["status"]),
              durationSec: fromLive?.durationSec ?? fromCurrent?.durationSec,
              error: fromLive?.error ?? fromCurrent?.error,
            };
          });
          // Filter out backup if not present in live status
          const hasBackup = data.liveStatus!.phases.some((p) => p.name === "backup");
          return merged.filter((p) => hasBackup || p.name !== "backup");
        });
        if (data.liveStatus.currentPhase) {
          setPhaseStartedAt(Date.now());
        }
      }
      offsetsRef.current = { logOffset: data.logOffset, phaseOffset: data.phaseOffset };
    });

    es.addEventListener("log", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { line: string; timestamp: string };
      setLogs((prev) => [...prev, data]);
    });

    es.addEventListener("phase", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      applyPhaseUpdate(data);
    });

    es.addEventListener("offset", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        logOffset: number;
        phaseOffset: number;
      };
      offsetsRef.current = data;
    });

    es.addEventListener("complete", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        success: boolean;
        error?: string;
        durationMs?: number;
      };
      setStatus(data.success ? "complete" : "error");
      if (!data.success && data.error) {
        setErrorMsg((prev) => prev || data.error || "Erro");
      }
      if (data.durationMs) setDuration(data.durationMs);
      void fetchHistory();
      try {
        es.close();
      } catch {}
      eventSourceRef.current = null;
    });

    es.addEventListener("error", () => {
      // Não é um erro fatal: provavelmente o Next.js está reiniciando (PM2 restart).
      // O processo de update continua rodando em background — tentamos reconectar.
      setReconnecting(true);
      try {
        es.close();
      } catch {}
      eventSourceRef.current = null;
      // Backoff curto: 2s
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        // Antes de reconectar, checa se ainda existe update ativo
        void (async () => {
          try {
            const res = await fetch("/api/update/status");
            const data = await res.json();
            if (data.active) {
              connectStream();
            } else {
              // Já terminou enquanto Next.js estava fora — atualiza histórico
              setReconnecting(false);
              void fetchHistory();
              void fetchCheck(true);
            }
          } catch {
            // Servidor ainda não voltou — tenta de novo em 3s
            reconnectTimerRef.current = setTimeout(connectStream, 3000);
          }
        })();
      }, 2000);
    });
  }, [applyPhaseUpdate, fetchCheck, fetchHistory]);

  // Mount: checagem inicial + recuperação de update em andamento
  useEffect(() => {
    void (async () => {
      // Verifica se há update já rodando (sobreviveu a restart do servidor)
      try {
        const res = await fetch("/api/update/status");
        const data = await res.json();
        if (data.active && data.status?.status === "running") {
          // Reanexa ao stream
          const live = data.status as UpdateLiveStatus;
          setLiveStatus(live);
          setStatus("updating");
          const hasBackup = live.phases.some((p) => p.name === "backup");
          initPhases(hasBackup);
          setPhases((prev) =>
            prev.map((p) => {
              const lp = live.phases.find((x) => x.name === p.name);
              return lp ? { ...p, ...lp } : p;
            })
          );
          offsetsRef.current = { logOffset: 0, phaseOffset: 0 };
          connectStream();
          return;
        }
      } catch {}

      void fetchCheck();
    })();

    void fetchHistory();

    // Polling para detectar updates (mantém a checagem mesmo sem o servidor falar com GitHub)
    const interval = setInterval(() => {
      // Não força check durante updating
      setStatus((prev) => {
        if (prev !== "updating") void fetchCheck();
        return prev;
      });
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(interval);
      if (eventSourceRef.current) {
        try {
          eventSourceRef.current.close();
        } catch {}
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll logs — limitado ao container do terminal para não puxar a
  // página inteira para baixo enquanto o usuário tenta ler o card de status.
  useEffect(() => {
    const container = logsEndRef.current?.closest<HTMLElement>(".overflow-y-auto");
    if (container) container.scrollTop = container.scrollHeight;
  }, [logs]);

  // Ticker para mostrar elapsed na fase atual (animação visual)
  useEffect(() => {
    if (status !== "updating") return;
    const t = setInterval(() => setElapsedTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const startUpdate = useCallback(async () => {
    setStatus("updating");
    setLogs([]);
    setErrorMsg("");
    setLiveStatus(null);
    setPhaseStartedAt(Date.now());
    offsetsRef.current = { logOffset: 0, phaseOffset: 0 };

    initPhases(true);

    try {
      const response = await fetch("/api/update/start", { method: "POST" });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Falha ao iniciar atualização");
      }
      const data = await response.json();
      if (data.phases) {
        const includeBackup = data.phases.some((p: UpdatePhase) => p.name === "backup");
        initPhases(includeBackup);
      }
      connectStream();
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Erro de conexão");
    }
  }, [connectStream, initPhases]);

  const renderPhaseIcon = (s: string) => {
    switch (s) {
      case "ok":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "fail":
        return <XCircle className="w-4 h-4 text-red-500" />;
      case "running":
        return <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />;
      case "skip":
        return <span className="text-gray-400 text-xs">pulado</span>;
      default:
        return <div className="w-3 h-3 rounded-full border-2 border-gray-500" />;
    }
  };

  const currentPhaseName = phases.find((p) => p.status === "running")?.name;
  const currentPhaseLabel = phases.find((p) => p.status === "running")?.label;
  const currentPhaseElapsed = phaseStartedAt ? Date.now() - phaseStartedAt + elapsedTick * 0 : 0;

  // Heartbeat age (re-computed every tick because elapsedTick fires every 1s)
  const heartbeatAgeMs = liveStatus?.lastHeartbeat
    ? Date.now() - new Date(liveStatus.lastHeartbeat).getTime() + elapsedTick * 0
    : 0;
  const buildStuck =
    currentPhaseName === "build" &&
    !!liveStatus?.lastHeartbeat &&
    heartbeatAgeMs > STUCK_THRESHOLD_MS;

  const cancelUpdate = async () => {
    if (!window.confirm("Cancelar o update? O processo será encerrado e o sistema fica no estado atual.")) {
      return;
    }
    try {
      const res = await fetch("/api/update/cancel", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Falha ao cancelar");
      setStatus("error");
      setErrorMsg(data?.message || "Update cancelado pelo usuário.");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Falha ao cancelar");
    }
  };

  return (
    <div
      className="card p-6"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ backgroundColor: "var(--surface-elevated)" }}
          >
            <Download className="w-6 h-6" style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <h2
              className="text-xl font-bold"
              style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}
            >
              Atualização do Sistema
            </h2>
            <p
              className="text-sm"
              style={{
                fontFamily: "var(--font-body)",
                color: "var(--text-secondary)",
              }}
            >
              {checkResult
                ? `Versão atual: ${checkResult.localSha.slice(0, 7)}`
                : "Verificando versão..."}
            </p>
          </div>
        </div>
        <button
          onClick={() => fetchCheck(true)}
          disabled={status === "loading" || status === "updating"}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          <RefreshCw
            className={`w-4 h-4 ${
              status === "loading" && !phases.length ? "animate-spin" : ""
            }`}
          />
          Verificar Agora
        </button>
      </div>

      {/* Body States */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ border: "1px solid var(--border)" }}
      >
        {/* Loading */}
        {status === "loading" && !phases.length && (
          <div className="p-6 text-center" style={{ backgroundColor: "var(--surface)" }}>
            <RefreshCw
              className="w-8 h-8 animate-spin mx-auto mb-2"
              style={{ color: "var(--text-muted)" }}
            />
            <p style={{ color: "var(--text-secondary)" }}>
              Verificando atualizações no GitHub...
            </p>
          </div>
        )}

        {/* Up to date */}
        {status === "uptodate" && checkResult && (
          <div
            className="p-6 flex items-start gap-4"
            style={{ backgroundColor: "rgba(34, 197, 94, 0.1)" }}
          >
            <CheckCircle className="w-6 h-6 mt-1" style={{ color: "var(--positive)" }} />
            <div>
              <h3
                className="text-lg font-bold mb-1"
                style={{ color: "var(--positive)", fontFamily: "var(--font-heading)" }}
              >
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
        {status === "available" && checkResult && (
          <div className="p-6" style={{ backgroundColor: "rgba(234, 179, 8, 0.1)" }}>
            <div className="flex items-start gap-4 mb-4">
              <AlertTriangle className="w-6 h-6 mt-1" style={{ color: "var(--warning)" }} />
              <div className="flex-1">
                <h3
                  className="text-lg font-bold mb-1"
                  style={{ color: "var(--warning)", fontFamily: "var(--font-heading)" }}
                >
                  Atualização disponível
                </h3>
                <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
                  {checkResult.behindBy} commits atrás · {checkResult.localSha.slice(0, 7)} →{" "}
                  {checkResult.remoteSha.slice(0, 7)}
                </p>

                {checkResult.commits.length > 0 && (
                  <div
                    className="rounded-lg p-3 mb-4 max-h-48 overflow-y-auto"
                    style={{
                      backgroundColor: "var(--surface)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <h4
                      className="text-xs font-bold uppercase tracking-wider mb-2"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Changelog Recente
                    </h4>
                    <ul className="space-y-2">
                      {checkResult.commits.slice(0, 10).map((c) => (
                        <li key={c.sha} className="text-sm flex gap-2">
                          <span className="text-gray-500 select-none">•</span>
                          <span>
                            <span style={{ color: "var(--text-primary)" }}>{c.message}</span>
                            <span style={{ color: "var(--text-muted)" }}> — {c.author}</span>
                          </span>
                        </li>
                      ))}
                      {checkResult.commits.length > 10 && (
                        <li
                          className="text-xs text-center pt-2"
                          style={{ color: "var(--text-muted)" }}
                        >
                          ...e mais {checkResult.commits.length - 10} commits
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={startUpdate}
                    className="px-5 py-2 rounded-lg font-bold text-sm transition-opacity hover:opacity-90"
                    style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                  >
                    🚀 Atualizar Agora
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Updating State */}
        {status === "updating" && (
          <div className="p-6" style={{ backgroundColor: "var(--surface)" }}>
            <h3
              className="font-bold mb-1 flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
            >
              <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--accent)" }} />
              Atualizando sistema...
              {reconnecting && (
                <span
                  className="text-xs px-2 py-0.5 rounded ml-2"
                  style={{
                    backgroundColor: "rgba(234, 179, 8, 0.2)",
                    color: "var(--warning)",
                  }}
                >
                  reconectando…
                </span>
              )}
            </h3>

            {/* Live phase status banner */}
            {currentPhaseName && (
              <div
                className="mb-4 p-3 rounded-lg flex items-center justify-between"
                style={{
                  backgroundColor: "rgba(59, 130, 246, 0.1)",
                  border: "1px solid rgba(59, 130, 246, 0.3)",
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div
                      className="w-3 h-3 rounded-full animate-pulse"
                      style={{ backgroundColor: "#60a5fa" }}
                    />
                    <div
                      className="absolute inset-0 w-3 h-3 rounded-full animate-ping"
                      style={{ backgroundColor: "#60a5fa", opacity: 0.4 }}
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      Em andamento: <strong>{currentPhaseLabel}</strong>
                    </div>
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {currentPhaseName === "backup"
                        ? "Compactando dados, configurações e workspace. Isso pode levar 1–3 minutos…"
                        : currentPhaseName === "build"
                        ? "Compilando Next.js para produção. Aguarde…"
                        : currentPhaseName === "npm-install"
                        ? "Instalando dependências…"
                        : currentPhaseName === "git-pull"
                        ? "Baixando atualizações do GitHub…"
                        : currentPhaseName === "pm2-restart"
                        ? "Reiniciando o servidor. A conexão pode cair brevemente — vou reconectar automaticamente."
                        : "Aguarde…"}
                    </div>
                  </div>
                </div>
                <div
                  className="text-sm font-mono tabular-nums"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {formatElapsed(currentPhaseElapsed)}
                </div>
              </div>
            )}

            {/* Phase Progress Pipeline */}
            <div className="flex flex-wrap gap-2 md:gap-3 mb-6">
              {phases.map((p, i) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 text-sm px-2 py-1 rounded"
                  style={{
                    backgroundColor:
                      p.status === "running" ? "rgba(59, 130, 246, 0.1)" : "transparent",
                  }}
                >
                  {renderPhaseIcon(p.status)}
                  <span
                    style={{
                      color:
                        p.status === "running" ? "var(--text-primary)" : "var(--text-muted)",
                      fontWeight: p.status === "running" ? 600 : 400,
                    }}
                  >
                    {p.label} {p.durationSec ? `(${p.durationSec}s)` : ""}
                  </span>
                  {i < phases.length - 1 && (
                    <span className="text-gray-600 mx-1">→</span>
                  )}
                </div>
              ))}
            </div>

            {/* Terminal */}
            <div
              className="rounded-lg p-4 h-64 overflow-y-auto w-full"
              style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  color: "#e6edf3",
                  lineHeight: 1.5,
                }}
              >
                {logs.map((log, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
                    <span
                      style={{ color: "#484f58", userSelect: "none", minWidth: "60px" }}
                    >
                      {log.timestamp.split("T")[1]?.slice(0, 8) || ""}
                    </span>
                    <span style={{ wordBreak: "break-all" }}>{log.line}</span>
                  </div>
                ))}
                <div className="flex gap-3 items-center mt-2">
                  <span style={{ color: "#484f58", minWidth: "60px" }}>—</span>
                  <span className="inline-flex gap-1">
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "#58a6ff", animationDelay: "0ms" }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "#58a6ff", animationDelay: "150ms" }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "#58a6ff", animationDelay: "300ms" }}
                    />
                  </span>
                </div>
                <div ref={logsEndRef} />
              </div>
            </div>

            {liveStatus && (
              <div
                className="mt-3 text-xs flex items-center gap-3 flex-wrap"
                style={{ color: "var(--text-muted)" }}
              >
                <span>PID: {liveStatus.pid}</span>
                <span>·</span>
                <span className="flex items-center gap-1">
                  Heartbeat:{" "}
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: heartbeatAgeColor(heartbeatAgeMs) }}
                  />
                  <span style={{ color: heartbeatAgeColor(heartbeatAgeMs), fontWeight: 600 }}>
                    {formatHeartbeatAge(heartbeatAgeMs)}
                  </span>
                </span>
                <span>·</span>
                <span>{liveStatus.fromSha} → {liveStatus.toSha}</span>
              </div>
            )}

            {/* Stuck-build banner: build phase + no heartbeat for >STUCK_THRESHOLD_MS.
                The deploy.sh emits heartbeats every 5s during build, so 60s+ of
                silence almost certainly means the build process is dead or hung.
                Surfaces a cancel button so user isn't stuck waiting forever. */}
            {buildStuck && (
              <div
                className="mt-3 p-3 rounded-lg flex items-start gap-3"
                style={{
                  backgroundColor: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.4)",
                }}
              >
                <AlertTriangle
                  className="w-5 h-5 mt-0.5 flex-shrink-0"
                  style={{ color: "#ef4444" }}
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold mb-1" style={{ color: "#ef4444" }}>
                    Build parece travado
                  </div>
                  <div className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
                    Nenhum heartbeat há {formatHeartbeatAge(heartbeatAgeMs)}. Normalmente o
                    build emite sinal a cada 5s. Verifique no servidor com{" "}
                    <code className="font-mono">ps aux | grep next-build</code> e{" "}
                    <code className="font-mono">tail data/update-current.log</code>.
                  </div>
                  <button
                    onClick={cancelUpdate}
                    className="text-xs px-3 py-1 rounded font-medium"
                    style={{
                      backgroundColor: "#ef4444",
                      color: "#fff",
                    }}
                  >
                    Cancelar update
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Complete State */}
        {status === "complete" && (
          <div className="p-6" style={{ backgroundColor: "rgba(34, 197, 94, 0.1)" }}>
            <div className="flex items-start gap-4">
              <CheckCircle className="w-6 h-6 mt-1" style={{ color: "var(--positive)" }} />
              <div className="flex-1">
                <h3
                  className="text-lg font-bold mb-1"
                  style={{ color: "var(--positive)", fontFamily: "var(--font-heading)" }}
                >
                  Atualização concluída com sucesso!
                </h3>
                <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
                  Duração: {Math.round(duration / 1000)}s
                </p>
                <button
                  onClick={() => {
                    setStatus("uptodate");
                    void fetchCheck(true);
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{
                    backgroundColor: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {status === "error" && (
          <div className="p-6" style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}>
            <div className="flex items-start gap-4">
              <XCircle className="w-6 h-6 mt-1 text-red-500" />
              <div className="flex-1 w-full min-w-0">
                <h3
                  className="text-lg font-bold mb-1 text-red-500"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  Falha na atualização
                </h3>
                <div className="rounded bg-red-950/30 border border-red-900 p-3 mb-4 text-sm text-red-200 break-words whitespace-pre-wrap">
                  {errorMsg || "Erro desconhecido"}
                </div>
                <p className="text-sm text-red-300 mb-4">
                  Um backup foi criado antes da atualização e o sistema continua rodando a
                  versão anterior. Verifique os logs abaixo ou o histórico para mais detalhes.
                </p>
                <button
                  onClick={() => fetchCheck(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-red-900/50 hover:bg-red-900 text-white transition-colors border border-red-700 mb-4"
                >
                  Tentar Novamente
                </button>

                {logs.length > 0 && (
                  <div
                    className="rounded-lg p-4 h-64 overflow-y-auto w-full"
                    style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        color: "#e6edf3",
                        lineHeight: 1.5,
                      }}
                    >
                      {logs.map((log, i) => (
                        <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
                          <span
                            style={{
                              color: "#484f58",
                              userSelect: "none",
                              minWidth: "60px",
                            }}
                          >
                            {log.timestamp.split("T")[1]?.slice(0, 8) || ""}
                          </span>
                          <span style={{ wordBreak: "break-all" }}>{log.line}</span>
                        </div>
                      ))}
                      <div ref={logsEndRef} />
                    </div>
                  </div>
                )}
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
          {showHistory ? "Ocultar Histórico" : "Ver Histórico de Atualizações"}
        </button>

        {showHistory && (
          <div
            className="mt-4 overflow-x-auto rounded-lg border"
            style={{ borderColor: "var(--border)" }}
          >
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
                {history.map((h) => (
                  <tr
                    key={h.id}
                    className="border-t"
                    style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  >
                    <td className="px-4 py-3">{new Date(h.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {h.fromSha} → {h.toSha}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-1 rounded text-xs ${
                          h.status === "success"
                            ? "bg-green-900/30 text-green-400"
                            : h.status === "error"
                            ? "bg-red-900/30 text-red-400"
                            : "bg-blue-900/30 text-blue-400"
                        }`}
                      >
                        {h.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {h.durationMs ? `${Math.round(h.durationMs / 1000)}s` : "-"}
                    </td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center italic text-gray-500"
                    >
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
