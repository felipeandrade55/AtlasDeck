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
  Wrench,
  Eye,
  AlertCircle,
  ShieldAlert,
  Bot,
} from "lucide-react";
import { AiRescueDialog } from "./AiRescueDialog";

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
  actions: Array<{ id: string; label: string; icon: typeof RefreshCw; severity: Severity; hint?: string; selfDisruptive?: boolean }>;
}> = [
  {
    title: "Resgate do OpenClaw",
    icon: LifeBuoy,
    intro: "Use esta sequência se o gateway caiu ou os agentes pararam de responder.",
    actions: [
      { id: "gateway-start", label: "Iniciar Gateway", icon: Play, severity: "caution", hint: "Inicia o openclaw daemon quando está totalmente parado" },
      { id: "gateway-restart", label: "Reiniciar Gateway", icon: RefreshCw, severity: "caution", hint: "Reinicia o serviço openclaw-gateway (use se está rodando mas travado)" },
      { id: "gateway-diagnose", label: "Diagnosticar Tudo", icon: Stethoscope, severity: "safe", hint: "Lista processos + status + help + portas em uma chamada" },
      { id: "openclaw-validate", label: "Validar Config", icon: Stethoscope, severity: "safe", hint: "Roda 'openclaw config validate' — mostra erros exatos de schema" },
      { id: "openclaw-channels-list", label: "Listar Canais", icon: Eye, severity: "safe", hint: "Lista canais ativos (telegram, etc.) no daemon" },
      { id: "openclaw-agent-test", label: "Testar Agente", icon: Bot, severity: "safe", hint: "Envia 'ping' direto pro agente main (bypass Telegram)" },
      { id: "openclaw-doctor", label: "Rodar Doctor", icon: Stethoscope, severity: "safe", hint: "openclaw doctor — diagnóstico completo" },
      { id: "openclaw-doctor-fix", label: "Doctor + Fix", icon: Wrench, severity: "caution", hint: "openclaw doctor --fix — corrige automaticamente o que conseguir" },
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
      { id: "mission-control-restart", label: "Reiniciar AtlasDeck", icon: ShieldAlert, severity: "destructive", hint: "A página vai cair por alguns segundos", selfDisruptive: true },
      { id: "vps-reboot", label: "Reiniciar servidor (VPS)", icon: Server, severity: "destructive", hint: "Reinicia o Linux inteiro — tudo cai e volta em ~1 minuto", selfDisruptive: true },
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
  const [confirmAction, setConfirmAction] = useState<{ id: string; label: string; severity: Severity; hint?: string; selfDisruptive?: boolean } | null>(null);

  // AI rescue dialog
  const [aiDialogOpen, setAiDialogOpen] = useState(false);

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

  const runAction = useCallback(async (action: { id: string; label: string; severity: Severity; selfDisruptive?: boolean }) => {
    setRunningAction(action.id);
    const startedAt = new Date().toISOString();
    const appendLog = (entry: ActionLogEntry) => setLog((prev) => [...prev, entry].slice(-50));
    try {
      const res = await fetch("/api/recovery/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.id }),
      });
      // Self-disruptive actions may kill the process before the body arrives —
      // parse defensively so an empty body doesn't surface as a JSON error.
      const data = await res.json().catch(() => ({}));
      appendLog({
        id: `${action.id}-${Date.now()}`,
        action: action.id,
        label: action.label,
        severity: action.severity,
        startedAt,
        durationMs: data.durationMs ?? 0,
        success: data.success ?? action.selfDisruptive ?? false,
        output: data.output || (action.selfDisruptive ? "Reinício em andamento — aguarde alguns segundos e recarregue a página." : ""),
        error: data.error,
      });
      // Refresh status after potentially mutating actions
      if (action.severity !== "safe" && !action.selfDisruptive) {
        setTimeout(fetchStatus, 1500);
      }
    } catch (e) {
      // For self-disruptive actions the dropped connection is expected — the
      // process is restarting. Report it as in-progress, not a failure.
      if (action.selfDisruptive) {
        appendLog({
          id: `${action.id}-${Date.now()}`,
          action: action.id,
          label: action.label,
          severity: action.severity,
          startedAt,
          durationMs: 0,
          success: true,
          output: "Reinício em andamento — a conexão caiu, como esperado. Aguarde alguns segundos e recarregue a página.",
        });
      } else {
        appendLog({
          id: `${action.id}-${Date.now()}`,
          action: action.id,
          label: action.label,
          severity: action.severity,
          startedAt,
          durationMs: 0,
          success: false,
          output: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setRunningAction(null);
    }
  }, [fetchStatus]);

  const handleActionClick = useCallback((action: { id: string; label: string; severity: Severity; hint?: string; selfDisruptive?: boolean }) => {
    if (action.severity === "destructive" || action.severity === "caution") {
      setConfirmAction(action);
    } else {
      runAction(action);
    }
  }, [runAction]);

  const buildAiSnapshot = useCallback((): string => {
    const parts: string[] = [];
    if (status) {
      parts.push(`OpenClaw saudável: ${status.openclaw.healthy}`);
      parts.push(`Gateway reachable: ${status.openclaw.gateway.reachable} (HTTP ${status.openclaw.gateway.status ?? "?"})`);
      parts.push(`Gateway systemd: active=${status.openclaw.gateway.systemd.active} sub=${status.openclaw.gateway.systemd.sub ?? "?"}`);
      parts.push(`Processos openclaw: ${status.openclaw.processes.count}`);
      parts.push(`Linux saudável: ${status.linux.healthy}`);
      parts.push(`Memória: ${status.linux.memory.percent}% usada`);
      if (status.linux.disk) {
        parts.push(`Disco /: ${status.linux.disk.percent}% (${status.linux.disk.used}/${status.linux.disk.size})`);
      }
      parts.push(`Load avg: ${status.linux.cpu.loadAvg.map((n) => n.toFixed(2)).join(", ")} em ${status.linux.cpu.cores} cores`);
      parts.push(`OpenClaw CLI instalado: ${status.openclaw.cli.installed} (${status.openclaw.cli.version ?? "?"})`);
    }
    if (log.length) {
      parts.push("");
      parts.push("Últimas ações executadas pelo operador (mais recentes por último):");
      for (const entry of log.slice(-5)) {
        parts.push(`--- ${entry.label} [${entry.success ? "ok" : "FALHOU"}] ---`);
        parts.push((entry.output || entry.error || "").slice(0, 1500));
      }
    }
    return parts.join("\n");
  }, [status, log]);

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

      {/* AI Assistant — trigger card (full UI lives in AiRescueDialog) */}
      <button
        type="button"
        onClick={() => setAiDialogOpen(true)}
        disabled={!status?.ai.anyAvailable}
        className="mt-6 w-full text-left rounded-lg p-4 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:scale-[1.005]"
        style={{
          backgroundColor: "rgba(139, 92, 246, 0.06)",
          border: "1px solid rgba(139, 92, 246, 0.3)",
        }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: "rgba(139, 92, 246, 0.15)" }}
            >
              <Sparkles className="w-5 h-5" style={{ color: "#a78bfa" }} />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
                Assistente de Resgate IA
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                {status?.ai.anyAvailable
                  ? "Descreva o problema, a IA analisa o snapshot e propõe (ou aplica) a correção."
                  : "Nenhum CLI detectado — instale claude ou codex no host para habilitar."}
              </p>
            </div>
          </div>
          <span
            className="text-xs font-medium px-3 py-1.5 rounded-lg shrink-0"
            style={{
              backgroundColor: "rgba(139, 92, 246, 0.2)",
              color: "#c4b5fd",
              border: "1px solid rgba(139, 92, 246, 0.4)",
            }}
          >
            Abrir assistente
          </span>
        </div>
      </button>

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

      {/* AI rescue dialog */}
      <AiRescueDialog
        open={aiDialogOpen}
        onClose={() => setAiDialogOpen(false)}
        context={{
          buildSnapshot: buildAiSnapshot,
          claudeAvailable: !!status?.ai.claude.installed,
          codexAvailable: !!status?.ai.codex.installed,
        }}
      />
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
