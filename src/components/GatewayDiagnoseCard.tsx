"use client";

/**
 * Self-service diagnose card for /settings — surfaces the same data the
 * /api/diagnose/gateway endpoint returns, but rendered with traffic lights
 * and copy-to-clipboard. Built so the user (or me in a future session) can
 * resolve "Telegram não responde" without SSH.
 *
 * Data flow:
 *   - Mount: auto-fetch once
 *   - Manual refresh button — most common path
 *   - "Copiar JSON" — gives the user a payload to paste back to me
 *   - Incidents expand inline; full preview is already in the response
 */
import { useCallback, useEffect, useState } from "react";
import {
  Stethoscope,
  CheckCircle,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Copy,
  ChevronDown,
  ChevronRight,
  Loader2,
  Power,
} from "lucide-react";

interface DiagnoseResponse {
  timestamp: string;
  runtime: "systemd" | "pm2" | "process" | "unknown";
  pids: Array<{ pid: number; startedAt: string; ageSeconds: number }>;
  config: {
    path: string;
    dirty: boolean;
    cleanedTelegram: boolean;
    cleanedWhatsapp: boolean;
    error?: string;
    hint: string;
  };
  logs: { source: string; found: boolean; output: string } | null;
  incidents: Array<{
    file: string;
    modifiedAt: string;
    reason: string;
    preview: string;
  }>;
  health: {
    summary: { pass: number; warn: number; fail: number; skip: number; headline: string };
    ok: boolean;
    checks: Array<{ id: string; status: string; label: string; detail: string }>;
    routing: Array<{ accountId: string; pendingUpdates: number; webhookSet: boolean }>;
  } | null;
  watchdog: {
    started: boolean;
    restartAttemptsCount: number;
    restartLimit: number;
    circuitOpen: boolean;
    restartInFlight: boolean;
    lastTickAt: number;
  };
  watcher: { started: boolean; sweepsRun: number; sweepsThatChanged: number };
  agentFailure: {
    detected: boolean;
    patterns: string[];
    summary: string;
    hint: string;
  } | null;
}

type Severity = "ok" | "warn" | "fail";

interface DerivedSignal {
  key: string;
  label: string;
  severity: Severity;
  detail: string;
}

/**
 * Map the raw endpoint payload into 5 "what matters" rows so the user
 * sees the answer instead of scrolling JSON. Each row picks the worst
 * field that maps to its concept — e.g. "Auto-recuperação ativa" reads
 * both watchdog.started and watchdog.circuitOpen because either being
 * off is the same user-visible failure.
 */
function deriveSignals(d: DiagnoseResponse): DerivedSignal[] {
  const signals: DerivedSignal[] = [];

  // Gateway alive
  signals.push({
    key: "gateway",
    label: "Gateway OpenClaw",
    severity: d.runtime === "unknown" ? "fail" : d.pids.length === 0 ? "fail" : "ok",
    detail:
      d.runtime === "unknown"
        ? "Nenhum processo detectado"
        : `${d.runtime} · ${d.pids.length} PID${d.pids.length === 1 ? "" : "s"}` +
          (d.pids[0] ? ` · up ${formatAge(d.pids[0].ageSeconds)}` : ""),
  });

  // Config schema-valid
  signals.push({
    key: "config",
    label: "openclaw.json",
    severity: d.config.error ? "fail" : d.config.dirty ? "warn" : "ok",
    detail: d.config.error ? d.config.error : d.config.dirty ? "Tem campos rejeitados — próximo restart vai limpar" : "Schema-valid",
  });

  // Telegram channel
  if (d.health) {
    const failCount = d.health.summary.fail;
    const warnCount = d.health.summary.warn;
    const sev: Severity = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "ok";
    const pending = d.health.routing[0]?.pendingUpdates ?? 0;
    signals.push({
      key: "telegram",
      label: "Canal Telegram",
      severity: sev,
      detail: `${d.health.summary.headline} · ${pending} pending`,
    });
  }

  // Watchdog ready
  signals.push({
    key: "watchdog",
    label: "Auto-recuperação",
    severity: !d.watchdog.started ? "fail" : d.watchdog.circuitOpen ? "warn" : "ok",
    detail: !d.watchdog.started
      ? "Watchdog não subiu"
      : d.watchdog.circuitOpen
        ? `Pausada (${d.watchdog.restartAttemptsCount}/${d.watchdog.restartLimit} tentativas em 30min) — investigue`
        : d.watchdog.restartInFlight
          ? "Reiniciando agora"
          : `Pronta (${d.watchdog.restartAttemptsCount}/${d.watchdog.restartLimit} budget consumido)`,
  });

  // Config watcher
  signals.push({
    key: "watcher",
    label: "Watcher do config",
    severity: d.watcher.started ? "ok" : "warn",
    detail: d.watcher.started
      ? `Ativo · ${d.watcher.sweepsRun} sweep${d.watcher.sweepsRun === 1 ? "" : "s"} (${d.watcher.sweepsThatChanged} com limpeza)`
      : "Não iniciou — restart manual em campos rejeitados",
  });

  // Agent failure scan (Codex / embedded run). Surfaces the "bot silent
  // because the agent gave up" case that no other signal catches.
  if (d.agentFailure?.detected) {
    signals.push({
      key: "agent",
      label: "Agente OpenClaw",
      severity: "fail",
      detail: d.agentFailure.summary,
    });
  } else {
    signals.push({
      key: "agent",
      label: "Agente OpenClaw",
      severity: "ok",
      detail: "Sem falhas recentes detectadas no journalctl",
    });
  }

  return signals;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}min` : `${Math.floor(h / 24)}d${h % 24}h`;
}

function severityClasses(s: Severity): { icon: typeof CheckCircle; color: string; bg: string } {
  switch (s) {
    case "ok":
      return { icon: CheckCircle, color: "text-emerald-400", bg: "rgba(16, 185, 129, 0.08)" };
    case "warn":
      return { icon: AlertTriangle, color: "text-amber-400", bg: "rgba(245, 158, 11, 0.08)" };
    case "fail":
      return { icon: XCircle, color: "text-red-400", bg: "rgba(239, 68, 68, 0.10)" };
  }
}

type RestartState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; success: boolean; output: string };

export function GatewayDiagnoseCard() {
  const [data, setData] = useState<DiagnoseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIncidents, setExpandedIncidents] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [restartState, setRestartState] = useState<RestartState>({ kind: "idle" });

  const fetchDiag = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/diagnose/gateway", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as DiagnoseResponse;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Manual override: skip the Tier-2 12-min wait and reanimate the gateway
   * now. Reuses /api/actions restart-gateway which already runs the sweep
   * + systemctl restart + reset-failed path, so the user gets the same
   * defended restart they'd get from the watchdog.
   */
  const forceRestart = useCallback(async () => {
    if (!confirm("Reiniciar o gateway OpenClaw agora? Vai pausar Telegram por ~15-30s.")) return;
    setRestartState({ kind: "running" });
    try {
      const r = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart-gateway" }),
      });
      const j = (await r.json()) as { success?: boolean; output?: string; error?: string };
      const success = !!j.success;
      const output = j.output || j.error || "(sem detalhe)";
      setRestartState({ kind: "done", success, output });
      // Re-fetch diagnose after a beat so the user sees the new state
      setTimeout(() => void fetchDiag(), 3000);
    } catch (e) {
      setRestartState({
        kind: "done",
        success: false,
        output: e instanceof Error ? e.message : String(e),
      });
    }
  }, [fetchDiag]);

  useEffect(() => {
    void fetchDiag();
  }, [fetchDiag]);

  const copyJson = useCallback(async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // older browsers — silently ignore, user can still see the JSON in DevTools
    }
  }, [data]);

  const toggleIncident = useCallback((file: string) => {
    setExpandedIncidents((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const signals = data ? deriveSignals(data) : [];
  const worstSeverity: Severity = signals.some((s) => s.severity === "fail")
    ? "fail"
    : signals.some((s) => s.severity === "warn")
      ? "warn"
      : "ok";

  return (
    <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)" }}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <Stethoscope className="w-6 h-6 text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
              Diagnóstico do Gateway
            </h2>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Estado em tempo real do OpenClaw + Telegram + auto-recuperação. Use antes de SSH.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={forceRestart}
            disabled={restartState.kind === "running"}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-40"
            style={{
              backgroundColor: "rgba(245, 158, 11, 0.15)",
              color: "#fbbf24",
              border: "1px solid rgba(245, 158, 11, 0.35)",
            }}
            title="Reinicia o gateway agora — útil quando você sabe que o canal está travado e não quer esperar o auto-restart (até 12min)"
          >
            {restartState.kind === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Power className="w-3.5 h-3.5" />
            )}
            Forçar restart agora
          </button>
          <button
            onClick={copyJson}
            disabled={!data}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-40"
            style={{
              backgroundColor: "var(--card-elevated, rgba(255,255,255,0.04))",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
            title="Copiar JSON cru pra colar num chat de debug"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "Copiado" : "Copiar JSON"}
          </button>
          <button
            onClick={fetchDiag}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-40"
            style={{
              backgroundColor: "var(--card-elevated, rgba(255,255,255,0.04))",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Atualizar
          </button>
        </div>
      </div>

      {restartState.kind === "done" && (
        <div
          className="mb-4 p-3 rounded-lg text-sm"
          style={{
            backgroundColor: restartState.success ? "rgba(16, 185, 129, 0.10)" : "rgba(239, 68, 68, 0.10)",
            color: restartState.success ? "#6ee7b7" : "#fca5a5",
            border: `1px solid ${restartState.success ? "rgba(16, 185, 129, 0.25)" : "rgba(239, 68, 68, 0.25)"}`,
          }}
        >
          <div className="font-medium mb-1">
            {restartState.success ? "Restart disparado" : "Restart falhou"}
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words font-mono opacity-80 max-h-32 overflow-y-auto">
            {restartState.output}
          </pre>
        </div>
      )}

      {error && (
        <div
          className="mb-4 p-3 rounded-lg text-sm"
          style={{ backgroundColor: "rgba(239, 68, 68, 0.10)", color: "#fca5a5", border: "1px solid rgba(239, 68, 68, 0.25)" }}
        >
          Falhou: {error}
        </div>
      )}

      {!data && !error && (
        <div className="flex items-center gap-2 py-8 text-sm" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          Coletando estado…
        </div>
      )}

      {data && (
        <>
          {/* Summary banner */}
          <div
            className="mb-4 p-4 rounded-lg flex items-center gap-3"
            style={{ backgroundColor: severityClasses(worstSeverity).bg, border: `1px solid ${severityClasses(worstSeverity).bg.replace("0.08", "0.25").replace("0.10", "0.25")}` }}
          >
            {(() => {
              const SeverityIcon = severityClasses(worstSeverity).icon;
              return <SeverityIcon className={`w-5 h-5 ${severityClasses(worstSeverity).color}`} />;
            })()}
            <div className="flex-1">
              <div className="font-medium" style={{ color: "var(--text)" }}>
                {worstSeverity === "ok"
                  ? "Tudo saudável"
                  : worstSeverity === "warn"
                    ? "Algo merece atenção"
                    : "Problema crítico — investigue"}
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                Atualizado{" "}
                {new Date(data.timestamp).toLocaleString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </div>
            </div>
          </div>

          {/* Signals grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {signals.map((sig) => {
              const cls = severityClasses(sig.severity);
              const SignalIcon = cls.icon;
              return (
                <div
                  key={sig.key}
                  className="p-3 rounded-lg flex items-start gap-3"
                  style={{
                    backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                    border: "1px solid var(--border)",
                  }}
                >
                  <SignalIcon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${cls.color}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
                      {sig.label}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                      {sig.detail}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Incidents list — empty most of the time, gold when present */}
          {data.incidents.length > 0 && (
            <div
              className="rounded-lg p-3"
              style={{
                backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
              }}
            >
              <div className="text-sm font-medium mb-2" style={{ color: "var(--text)" }}>
                Últimos {data.incidents.length} incident{data.incidents.length === 1 ? "" : "s"}{" "}
                <span style={{ color: "var(--text-muted)" }} className="text-xs font-normal">
                  · cada um é um snapshot do journalctl no momento do auto-restart
                </span>
              </div>
              <div className="space-y-1">
                {data.incidents.map((inc) => {
                  const isOpen = expandedIncidents.has(inc.file);
                  return (
                    <div key={inc.file} className="text-xs">
                      <button
                        onClick={() => toggleIncident(inc.file)}
                        className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/5 transition-colors"
                        style={{ color: "var(--text)" }}
                      >
                        {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <span className="font-mono">{inc.reason}</span>
                        <span style={{ color: "var(--text-muted)" }}>
                          · {new Date(inc.modifiedAt).toLocaleString("pt-BR")}
                        </span>
                      </button>
                      {isOpen && (
                        <pre
                          className="ml-5 p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words"
                          style={{
                            backgroundColor: "rgba(0,0,0,0.3)",
                            color: "var(--text-muted)",
                            border: "1px solid var(--border)",
                            maxHeight: "240px",
                            overflowY: "auto",
                          }}
                        >
                          {inc.preview}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
