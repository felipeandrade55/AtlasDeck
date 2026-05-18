"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LifeBuoy,
  HeartPulse,
  Activity,
  Server,
  Terminal as TerminalIcon,
  RefreshCw,
  Play,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Stethoscope,
  Sparkles,
  Trash2,
  Cpu,
  HardDrive,
  Wifi,
  WifiOff,
  Bot,
  Wrench,
  Eye,
  AlertCircle,
  ShieldAlert,
} from "lucide-react";

type Severity = "safe" | "caution" | "destructive";

interface RecoveryStatus {
  timestamp: string;
  openclaw: {
    healthy: boolean;
    cli: { installed: boolean; path: string | null; version: string | null };
    directory: { exists: boolean; configExists: boolean; dir: string };
    gateway: {
      reachable: boolean;
      status: number | null;
      latencyMs: number | null;
      port: number;
      url: string;
      systemd: { exists: boolean; active: boolean; sub: string | null; since: string | null };
    };
    processes: { count: number; pids: number[] };
  };
  linux: {
    healthy: boolean;
    hostname: string;
    platform: string;
    uptimeSec: number;
    cpu: { cores: number; loadAvg: number[] };
    memory: { total: number; free: number; used: number; percent: number };
    disk: { filesystem: string; size: string; used: string; avail: string; percent: number } | null;
    missionControl: { exists: boolean; active: boolean; sub: string | null; since: string | null };
  };
  ai: {
    claude: { installed: boolean; path: string | null; version: string | null };
    codex: { installed: boolean; path: string | null; version: string | null };
    anyAvailable: boolean;
  };
}

interface ActionLogEntry {
  id: string;
  action: string;
  label: string;
  severity: Severity;
  startedAt: string;
  durationMs: number;
  success: boolean;
  output: string;
  error?: string;
}

// One-click recovery groups. Order = priority for the layout.
const QUICK_GROUPS: Array<{
  title: string;
  icon: typeof LifeBuoy;
  intro: string;
  actions: Array<{ id: string; label: string; icon: typeof RefreshCw; severity: Severity; hint?: string }>;
}> = [
  {
    title: "Resgate do OpenClaw",
    icon: LifeBuoy,
    intro: "Use esta sequência se o gateway caiu ou os agentes pararam de responder.",
    actions: [
      { id: "gateway-restart", label: "Reiniciar Gateway", icon: RefreshCw, severity: "caution", hint: "Reinicia o serviço openclaw-gateway" },
      { id: "openclaw-doctor", label: "Rodar Doctor", icon: Stethoscope, severity: "safe", hint: "openclaw doctor — diagnóstico completo" },
      { id: "openclaw-status", label: "Status do OpenClaw", icon: HeartPulse, severity: "safe" },
      { id: "gateway-logs", label: "Logs do Gateway", icon: Eye, severity: "safe" },
      { id: "gateway-logs-errors", label: "Apenas erros recentes", icon: AlertCircle, severity: "safe" },
      { id: "openclaw-update", label: "Atualizar OpenClaw", icon: Wrench, severity: "caution", hint: "Pode demorar alguns minutos" },
    ],
  },
  {
    title: "Diagnóstico do Linux",
    icon: Cpu,
    intro: "Veja o que está consumindo recursos. Comandos somente-leitura.",
    actions: [
      { id: "disk-usage", label: "Uso de Disco", icon: HardDrive, severity: "safe" },
      { id: "memory-status", label: "Memória RAM", icon: Cpu, severity: "safe" },
      { id: "top-mem-processes", label: "Top RAM", icon: Activity, severity: "safe" },
      { id: "top-cpu-processes", label: "Top CPU", icon: Activity, severity: "safe" },
      { id: "load-uptime", label: "Load / Uptime", icon: Server, severity: "safe" },
      { id: "network-listen", label: "Portas Abertas", icon: Wifi, severity: "safe" },
      { id: "system-journal-errors", label: "Erros do sistema", icon: AlertCircle, severity: "safe" },
      { id: "disk-top-dirs", label: "Pastas pesadas", icon: HardDrive, severity: "safe" },
    ],
  },
  {
    title: "Limpeza preventiva",
    icon: Trash2,
    intro: "Libera espaço quando o disco está cheio. Operações idempotentes.",
    actions: [
      { id: "clear-tmp-old", label: "Limpar /tmp antigo", icon: Trash2, severity: "caution" },
      { id: "clear-pm2-logs", label: "Limpar logs PM2", icon: Trash2, severity: "caution" },
      { id: "clear-journal-old", label: "Limpar journal >7d", icon: Trash2, severity: "caution" },
    ],
  },
  {
    title: "Processos",
    icon: Server,
    intro: "PM2 e estado do próprio dashboard.",
    actions: [
      { id: "pm2-list", label: "Listar PM2", icon: Activity, severity: "safe" },
      { id: "pm2-resurrect", label: "Reanimar PM2", icon: RefreshCw, severity: "caution" },
      { id: "mission-control-restart", label: "Reiniciar AtlasDeck", icon: ShieldAlert, severity: "destructive", hint: "A página vai cair por alguns segundos" },
    ],
  },
];

const SEVERITY_STYLES: Record<Severity, { bg: string; border: string; text: string; ring: string }> = {
  safe: {
    bg: "rgba(16, 185, 129, 0.08)",
    border: "rgba(16, 185, 129, 0.35)",
    text: "#34d399",
    ring: "rgba(16, 185, 129, 0.5)",
  },
  caution: {
    bg: "rgba(234, 179, 8, 0.08)",
    border: "rgba(234, 179, 8, 0.35)",
    text: "#facc15",
    ring: "rgba(234, 179, 8, 0.5)",
  },
  destructive: {
    bg: "rgba(239, 68, 68, 0.08)",
    border: "rgba(239, 68, 68, 0.35)",
    text: "#f87171",
    ring: "rgba(239, 68, 68, 0.5)",
  },
};

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || `${sec}s`;
}

export function RecoveryPanel() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [log, setLog] = useState<ActionLogEntry[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ id: string; label: string; severity: Severity; hint?: string } | null>(null);

  // AI assistant state
  const [aiProblem, setAiProblem] = useState("");
  const [aiMode, setAiMode] = useState<"analyze" | "fix">("analyze");
  const [aiCli, setAiCli] = useState<"auto" | "claude" | "codex">("auto");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{
    success: boolean;
    cli?: string;
    mode?: string;
    output?: string;
    stderr?: string;
    error?: string;
    durationMs?: number;
    timedOut?: boolean;
  } | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/recovery/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RecoveryStatus = await res.json();
      setStatus(data);
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 15_000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [log.length]);

  const runAction = useCallback(async (action: { id: string; label: string; severity: Severity }) => {
    setRunningAction(action.id);
    const startedAt = new Date().toISOString();
    try {
      const res = await fetch("/api/recovery/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.id }),
      });
      const data = await res.json();
      const entry: ActionLogEntry = {
        id: `${action.id}-${Date.now()}`,
        action: action.id,
        label: action.label,
        severity: action.severity,
        startedAt,
        durationMs: data.durationMs ?? 0,
        success: !!data.success,
        output: data.output || "",
        error: data.error,
      };
      setLog((prev) => [...prev, entry].slice(-50));
      // Refresh status after potentially mutating actions
      if (action.severity !== "safe") {
        setTimeout(fetchStatus, 1500);
      }
    } catch (e) {
      setLog((prev) => [
        ...prev,
        {
          id: `${action.id}-${Date.now()}`,
          action: action.id,
          label: action.label,
          severity: action.severity,
          startedAt,
          durationMs: 0,
          success: false,
          output: "",
          error: e instanceof Error ? e.message : String(e),
        },
      ].slice(-50));
    } finally {
      setRunningAction(null);
    }
  }, [fetchStatus]);

  const handleActionClick = useCallback((action: { id: string; label: string; severity: Severity; hint?: string }) => {
    if (action.severity === "destructive" || action.severity === "caution") {
      setConfirmAction(action);
    } else {
      runAction(action);
    }
  }, [runAction]);

  const askAi = useCallback(async () => {
    setAiLoading(true);
    setAiResult(null);
    try {
      // Build a fresh context snapshot from the last 5 log entries + current status
      const contextParts: string[] = [];
      if (status) {
        contextParts.push(`OpenClaw saudável: ${status.openclaw.healthy}`);
        contextParts.push(`Gateway reachable: ${status.openclaw.gateway.reachable} (HTTP ${status.openclaw.gateway.status ?? "?"})`);
        contextParts.push(`Gateway systemd: active=${status.openclaw.gateway.systemd.active} sub=${status.openclaw.gateway.systemd.sub ?? "?"}`);
        contextParts.push(`Processos openclaw: ${status.openclaw.processes.count}`);
        contextParts.push(`Linux saudável: ${status.linux.healthy}`);
        contextParts.push(`Memória: ${status.linux.memory.percent}% usada`);
        if (status.linux.disk) {
          contextParts.push(`Disco /: ${status.linux.disk.percent}% (${status.linux.disk.used}/${status.linux.disk.size})`);
        }
        contextParts.push(`Load avg: ${status.linux.cpu.loadAvg.map((n) => n.toFixed(2)).join(", ")} em ${status.linux.cpu.cores} cores`);
        contextParts.push(`OpenClaw CLI instalado: ${status.openclaw.cli.installed} (${status.openclaw.cli.version ?? "?"})`);
      }
      if (log.length) {
        contextParts.push("");
        contextParts.push("Últimas ações executadas pelo operador (mais recentes por último):");
        for (const entry of log.slice(-5)) {
          contextParts.push(`--- ${entry.label} [${entry.success ? "ok" : "FALHOU"}] ---`);
          contextParts.push((entry.output || entry.error || "").slice(0, 1500));
        }
      }

      const res = await fetch("/api/recovery/ai-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problem: aiProblem,
          mode: aiMode,
          cli: aiCli,
          context: contextParts.join("\n"),
        }),
      });
      const data = await res.json();
      setAiResult(data);
    } catch (e) {
      setAiResult({ success: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAiLoading(false);
    }
  }, [aiProblem, aiMode, aiCli, status, log]);

  // ─── Render helpers ───────────────────────────────────────────
  const openclawHealth = useMemo(() => {
    if (!status) return null;
    const o = status.openclaw;
    if (o.healthy) return { color: "#34d399", label: "OpenClaw operacional", icon: CheckCircle2 };
    if (!o.gateway.reachable) return { color: "#f87171", label: "Gateway inacessível", icon: WifiOff };
    if (!o.directory.exists) return { color: "#f87171", label: "Diretório do OpenClaw não encontrado", icon: XCircle };
    return { color: "#facc15", label: "OpenClaw com problemas", icon: AlertTriangle };
  }, [status]);

  const linuxHealth = useMemo(() => {
    if (!status) return null;
    if (status.linux.healthy) return { color: "#34d399", label: "Linux saudável", icon: CheckCircle2 };
    return { color: "#facc15", label: "Linux sob pressão", icon: AlertTriangle };
  }, [status]);

  return (
    <div
      className="rounded-xl p-4 md:p-6"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h2
            className="text-xl font-semibold flex items-center gap-2"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            <LifeBuoy className="w-5 h-5" style={{ color: "#f87171" }} />
            Resgate &amp; Recuperação
          </h2>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Se o OpenClaw cair, use este painel para diagnosticar e reanimar o sistema em poucos cliques.
          </p>
        </div>
        <button
          onClick={fetchStatus}
          disabled={statusLoading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50"
          style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <HealthCard
          title="OpenClaw"
          icon={openclawHealth?.icon ?? Loader2}
          color={openclawHealth?.color ?? "var(--text-muted)"}
          label={openclawHealth?.label ?? "Carregando..."}
          rows={status ? [
            { k: "Gateway", v: status.openclaw.gateway.reachable ? `OK (${status.openclaw.gateway.status ?? "?"}) · ${status.openclaw.gateway.latencyMs}ms` : "Inacessível" },
            { k: "systemd", v: `${status.openclaw.gateway.systemd.exists ? (status.openclaw.gateway.systemd.active ? "active" : (status.openclaw.gateway.systemd.sub ?? "inactive")) : "unit não encontrado"}` },
            { k: "Processos", v: `${status.openclaw.processes.count}` },
            { k: "CLI", v: status.openclaw.cli.installed ? (status.openclaw.cli.version ?? "instalado") : "não encontrado" },
            { k: "Workspace", v: status.openclaw.directory.exists ? status.openclaw.directory.dir : "ausente" },
          ] : []}
        />
        <HealthCard
          title="Linux"
          icon={linuxHealth?.icon ?? Loader2}
          color={linuxHealth?.color ?? "var(--text-muted)"}
          label={linuxHealth?.label ?? "Carregando..."}
          rows={status ? [
            { k: "Host", v: status.linux.hostname },
            { k: "Uptime", v: formatUptime(status.linux.uptimeSec) },
            { k: "Load", v: `${status.linux.cpu.loadAvg.map((n) => n.toFixed(2)).join(" / ")} (${status.linux.cpu.cores} cores)` },
            { k: "RAM", v: `${formatBytes(status.linux.memory.used)} / ${formatBytes(status.linux.memory.total)} (${status.linux.memory.percent}%)` },
            { k: "Disco", v: status.linux.disk ? `${status.linux.disk.used} / ${status.linux.disk.size} (${status.linux.disk.percent}%)` : "n/d" },
          ] : []}
        />
        <HealthCard
          title="Assistente IA"
          icon={status?.ai.anyAvailable ? CheckCircle2 : XCircle}
          color={status?.ai.anyAvailable ? "#a78bfa" : "var(--text-muted)"}
          label={status?.ai.anyAvailable ? "CLI disponível" : "Nenhum CLI instalado"}
          rows={status ? [
            { k: "Claude Code", v: status.ai.claude.installed ? (status.ai.claude.version ?? "instalado") : "não instalado" },
            { k: "Codex", v: status.ai.codex.installed ? (status.ai.codex.version ?? "instalado") : "não instalado" },
          ] : []}
        />
      </div>

      {statusError && (
        <div className="mb-4 p-3 rounded-lg flex items-center gap-2 text-sm" style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
          <AlertCircle className="w-4 h-4" />
          Não consegui carregar o status: {statusError}
        </div>
      )}

      {/* Action groups */}
      <div className="space-y-5">
        {QUICK_GROUPS.map((group) => {
          const Icon = group.icon;
          return (
            <div key={group.title} className="rounded-lg p-4" style={{ backgroundColor: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
                <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>{group.title}</h3>
              </div>
              <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>{group.intro}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {group.actions.map((action) => {
                  const ActionIcon = action.icon;
                  const isRunning = runningAction === action.id;
                  const sty = SEVERITY_STYLES[action.severity];
                  return (
                    <button
                      key={action.id}
                      onClick={() => handleActionClick(action)}
                      disabled={!!runningAction}
                      title={action.hint}
                      className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:scale-[1.01]"
                      style={{ backgroundColor: sty.bg, borderColor: sty.border, color: sty.text }}
                    >
                      <span className="flex items-center gap-2 text-left">
                        {isRunning ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <ActionIcon className="w-4 h-4 shrink-0" />}
                        <span>{action.label}</span>
                      </span>
                      {action.severity !== "safe" && (
                        <span className="text-[10px] uppercase tracking-wider opacity-70">
                          {action.severity === "destructive" ? "risco" : "cuidado"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Assistant */}
      <div className="mt-6 rounded-lg p-4" style={{ backgroundColor: "rgba(139, 92, 246, 0.06)", border: "1px solid rgba(139, 92, 246, 0.3)" }}>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4" style={{ color: "#a78bfa" }} />
          <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Pedir ajuda à IA</h3>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
          Envia o snapshot atual + sua descrição para o Claude Code ou Codex CLI instalado no servidor.
          {!status?.ai.anyAvailable && " Nenhum CLI detectado — instale claude ou codex no host."}
        </p>

        <textarea
          value={aiProblem}
          onChange={(e) => setAiProblem(e.target.value)}
          placeholder="Descreva o problema: ex. 'gateway voltou 503', 'agentes não respondem desde a madrugada', 'disco encheu'..."
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-sm mb-3 resize-y"
          style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
        />

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color: "var(--text-secondary)" }}>Modo:</label>
            <select
              value={aiMode}
              onChange={(e) => setAiMode(e.target.value as "analyze" | "fix")}
              className="text-xs rounded px-2 py-1"
              style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            >
              <option value="analyze">Apenas analisar (somente leitura)</option>
              <option value="fix">Tentar corrigir (executa comandos)</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color: "var(--text-secondary)" }}>CLI:</label>
            <select
              value={aiCli}
              onChange={(e) => setAiCli(e.target.value as "auto" | "claude" | "codex")}
              className="text-xs rounded px-2 py-1"
              style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            >
              <option value="auto">Automático</option>
              <option value="claude" disabled={!status?.ai.claude.installed}>Claude Code{!status?.ai.claude.installed && " (n/d)"}</option>
              <option value="codex" disabled={!status?.ai.codex.installed}>Codex{!status?.ai.codex.installed && " (n/d)"}</option>
            </select>
          </div>
          {aiMode === "fix" && (
            <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "#f87171" }}>
              <ShieldAlert className="w-3 h-3" />
              Modo correção: a IA poderá executar comandos no servidor.
            </div>
          )}
        </div>

        <button
          onClick={askAi}
          disabled={aiLoading || !status?.ai.anyAvailable}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: "rgba(139, 92, 246, 0.2)", color: "#c4b5fd", border: "1px solid rgba(139, 92, 246, 0.4)" }}
        >
          {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
          {aiLoading ? "IA pensando..." : "Pedir ajuda à IA"}
        </button>

        {aiResult && (
          <div className="mt-3 rounded-lg p-3" style={{ backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between text-xs mb-2" style={{ color: "var(--text-muted)" }}>
              <span>
                {aiResult.cli ? `via ${aiResult.cli}` : "—"} · modo {aiResult.mode ?? "—"} · {aiResult.durationMs ? `${(aiResult.durationMs / 1000).toFixed(1)}s` : "?"}
                {aiResult.timedOut && " · timeout"}
              </span>
              <span style={{ color: aiResult.success ? "#34d399" : "#f87171" }}>
                {aiResult.success ? "ok" : "falhou"}
              </span>
            </div>
            {aiResult.error && (
              <div className="text-xs mb-2" style={{ color: "#f87171" }}>{aiResult.error}</div>
            )}
            <pre className="text-xs whitespace-pre-wrap font-mono max-h-96 overflow-auto" style={{ color: "var(--text-primary)" }}>
              {aiResult.output || aiResult.stderr || "(sem saída)"}
            </pre>
          </div>
        )}
      </div>

      {/* Output log */}
      <div className="mt-6 rounded-lg p-4" style={{ backgroundColor: "rgba(0,0,0,0.35)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4" style={{ color: "var(--accent)" }} />
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Saída das ações</h3>
          </div>
          {log.length > 0 && (
            <button
              onClick={() => setLog([])}
              className="text-xs underline"
              style={{ color: "var(--text-muted)" }}
            >
              limpar
            </button>
          )}
        </div>
        {log.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
            Nenhuma ação executada ainda. Clique em um botão acima para começar.
          </p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-auto pr-1">
            {log.map((entry) => (
              <div key={entry.id} className="rounded p-2" style={{ backgroundColor: "rgba(0,0,0,0.4)", border: `1px solid ${entry.success ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.3)"}` }}>
                <div className="flex items-center justify-between gap-2 text-xs mb-1">
                  <span className="flex items-center gap-1.5" style={{ color: "var(--text-secondary)" }}>
                    {entry.success ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400" />}
                    <span className="font-medium" style={{ color: "var(--text-primary)" }}>{entry.label}</span>
                    <span style={{ color: "var(--text-muted)" }}>· {(entry.durationMs / 1000).toFixed(2)}s</span>
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {new Date(entry.startedAt).toLocaleTimeString()}
                  </span>
                </div>
                {entry.error && (
                  <div className="text-xs mb-1" style={{ color: "#f87171" }}>{entry.error}</div>
                )}
                {entry.output && (
                  <pre className="text-[11px] whitespace-pre-wrap font-mono max-h-48 overflow-auto" style={{ color: "var(--text-primary)" }}>
                    {entry.output}
                  </pre>
                )}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        )}
      </div>

      {/* Confirm dialog */}
      {confirmAction && (
        <ConfirmDialog
          action={confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            const a = confirmAction;
            setConfirmAction(null);
            runAction(a);
          }}
        />
      )}
    </div>
  );
}

function HealthCard({
  title,
  icon: Icon,
  color,
  label,
  rows,
}: {
  title: string;
  icon: typeof CheckCircle2;
  color: string;
  label: string;
  rows: Array<{ k: string; v: string }>;
}) {
  return (
    <div className="rounded-lg p-3" style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{title}</span>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="font-semibold mb-2 text-sm" style={{ color }}>{label}</div>
      <div className="space-y-0.5 text-xs">
        {rows.map((r, i) => (
          <div key={i} className="flex justify-between gap-2">
            <span style={{ color: "var(--text-muted)" }}>{r.k}</span>
            <span className="truncate text-right max-w-[60%]" style={{ color: "var(--text-secondary)" }} title={r.v}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmDialog({
  action,
  onCancel,
  onConfirm,
}: {
  action: { id: string; label: string; severity: Severity; hint?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDestructive = action.severity === "destructive";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
      <div
        className="rounded-xl p-5 max-w-md w-full"
        style={{ backgroundColor: "var(--card)", border: `1px solid ${isDestructive ? "rgba(239,68,68,0.4)" : "rgba(234,179,8,0.4)"}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          {isDestructive ? <ShieldAlert className="w-5 h-5 text-red-400" /> : <AlertTriangle className="w-5 h-5 text-yellow-400" />}
          <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Confirmar ação</h3>
        </div>
        <p className="text-sm mb-1" style={{ color: "var(--text-primary)" }}>
          Executar <strong>{action.label}</strong>?
        </p>
        {action.hint && (
          <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>{action.hint}</p>
        )}
        {isDestructive && (
          <p className="text-xs mb-3 p-2 rounded" style={{ color: "#fca5a5", backgroundColor: "rgba(239,68,68,0.1)" }}>
            Esta ação pode interromper serviços ou apagar dados. Tenha certeza antes de prosseguir.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg"
            style={{ backgroundColor: "rgba(255,255,255,0.05)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-lg font-medium flex items-center gap-1.5"
            style={{
              backgroundColor: isDestructive ? "rgba(239,68,68,0.2)" : "rgba(234,179,8,0.2)",
              color: isDestructive ? "#fca5a5" : "#fde68a",
              border: `1px solid ${isDestructive ? "rgba(239,68,68,0.5)" : "rgba(234,179,8,0.5)"}`,
            }}
          >
            <Play className="w-3.5 h-3.5" />
            Executar
          </button>
        </div>
      </div>
    </div>
  );
}
