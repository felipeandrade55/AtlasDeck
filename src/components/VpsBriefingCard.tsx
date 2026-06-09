"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";

type HostStatus = "pending" | "online" | "offline";
type Severity = "ok" | "warning" | "critical";

interface ThresholdPair {
  warning: number;
  critical: number;
}

interface VpsHost {
  vps_id: string;
  name: string;
  hostname: string | null;
  last_seen_ms: number | null;
  status: HostStatus;
  thresholds: {
    cpu: ThresholdPair;
    ram: ThresholdPair;
    disk: ThresholdPair;
    load1PerCore: ThresholdPair;
    offlineSec: number;
  };
  last_snapshot: {
    metrics?: Record<string, number>;
    services?: Array<{ name: string; active: boolean; detail?: string }>;
    docker?: {
      installed: boolean;
      running?: boolean;
      containers?: Array<{ name: string; state: string }>;
    };
  };
}

interface Issue {
  hostId: string;
  hostName: string;
  label: string;
  detail: string;
  severity: Exclude<Severity, "ok">;
}

interface HostSummary {
  host: VpsHost;
  issues: Issue[];
  severity: Severity;
}

function metricSeverity(value: number | undefined, thresholds: ThresholdPair): Severity {
  if (typeof value !== "number" || !Number.isFinite(value)) return "ok";
  if (value >= thresholds.critical) return "critical";
  if (value >= thresholds.warning) return "warning";
  return "ok";
}

function formatLastSeen(ms: number | null): string {
  if (!ms) return "sem contato";
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function collectIssues(host: VpsHost): Issue[] {
  const issues: Issue[] = [];
  const metrics = host.last_snapshot?.metrics || {};

  if (host.status === "offline") {
    issues.push({
      hostId: host.vps_id,
      hostName: host.name,
      label: "VPS offline",
      detail: `Último contato: ${formatLastSeen(host.last_seen_ms)}`,
      severity: "critical",
    });
  }

  const metricChecks = [
    { key: "cpu_usage", label: "CPU", value: metrics.cpu_usage, thresholds: host.thresholds.cpu, icon: "%" },
    { key: "ram_used_pct", label: "RAM", value: metrics.ram_used_pct, thresholds: host.thresholds.ram, icon: "%" },
    { key: "disk_used_pct", label: "Disco", value: metrics.disk_used_pct, thresholds: host.thresholds.disk, icon: "%" },
    { key: "load1_per_core", label: "Load", value: metrics.load1_per_core, thresholds: host.thresholds.load1PerCore, icon: "/core" },
  ];

  for (const item of metricChecks) {
    const severity = metricSeverity(item.value, item.thresholds);
    if (severity === "ok" || typeof item.value !== "number") continue;
    issues.push({
      hostId: host.vps_id,
      hostName: host.name,
      label: `${item.label} ${severity === "critical" ? "crítico" : "alto"}`,
      detail: `${item.value.toFixed(item.icon === "/core" ? 2 : 0)}${item.icon}`,
      severity,
    });
  }

  for (const service of host.last_snapshot?.services || []) {
    if (service.active) continue;
    issues.push({
      hostId: host.vps_id,
      hostName: host.name,
      label: `Serviço inativo: ${service.name}`,
      detail: service.detail || "systemd reportou inativo",
      severity: "critical",
    });
  }

  const docker = host.last_snapshot?.docker;
  if (docker?.installed && docker.running === false) {
    issues.push({
      hostId: host.vps_id,
      hostName: host.name,
      label: "Docker parado",
      detail: "daemon indisponível",
      severity: "critical",
    });
  }

  for (const container of docker?.containers || []) {
    if (container.state === "running") continue;
    issues.push({
      hostId: host.vps_id,
      hostName: host.name,
      label: `Container parado: ${container.name}`,
      detail: container.state,
      severity: "critical",
    });
  }

  return issues;
}

function hostSeverity(host: VpsHost, issues: Issue[]): Severity {
  if (host.status === "offline" || issues.some((issue) => issue.severity === "critical")) return "critical";
  if (host.status === "pending" || issues.some((issue) => issue.severity === "warning")) return "warning";
  return "ok";
}

function severityColor(severity: Severity): string {
  if (severity === "critical") return "var(--error)";
  if (severity === "warning") return "var(--warning)";
  return "var(--success)";
}

function pctColor(value: number | undefined): string {
  if (typeof value !== "number") return "var(--text-muted)";
  if (value >= 90) return "var(--error)";
  if (value >= 75) return "var(--warning)";
  return "var(--success)";
}

export function VpsBriefingCard() {
  const [hosts, setHosts] = useState<VpsHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/vps", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setHosts(Array.isArray(data) ? data : []);
        setLastUpdated(new Date());
      } catch {
        if (!cancelled) setHosts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const hostSummaries = useMemo<HostSummary[]>(
    () =>
      hosts.map((host) => {
        const hostIssues = collectIssues(host);
        return { host, issues: hostIssues, severity: hostSeverity(host, hostIssues) };
      }),
    [hosts]
  );
  const issues = useMemo(() => hostSummaries.flatMap((summary) => summary.issues), [hostSummaries]);
  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const onlineCount = hosts.filter((host) => host.status === "online").length;
  const problemHosts = hostSummaries.filter((summary) => summary.severity !== "ok").length;
  const statusColor = criticalCount > 0 ? "var(--error)" : warningCount > 0 ? "var(--warning)" : "var(--success)";
  const statusLabel =
    hosts.length === 0
      ? "Nenhum VPS cadastrado"
      : criticalCount > 0
        ? `${criticalCount} crítico${criticalCount === 1 ? "" : "s"}`
        : warningCount > 0
          ? `${warningCount} alerta${warningCount === 1 ? "" : "s"}`
          : "Tudo operacional";

  return (
    <div
      className="rounded-xl overflow-hidden h-full"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4" style={{ color: statusColor }} />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Briefing VPS
          </span>
          {hosts.length > 0 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded font-mono"
              style={{ backgroundColor: "rgba(255,255,255,0.06)", color: statusColor }}
            >
              {statusLabel}
            </span>
          )}
        </div>
        <Link href="/system?tab=vps" className="text-xs font-medium" style={{ color: "var(--accent)" }}>
          Monitorar →
        </Link>
      </div>

      <div className="p-4 space-y-4">
        {loading && hosts.length === 0 ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Lendo monitoramento...
          </div>
        ) : hosts.length === 0 ? (
          <div className="flex items-start gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            <Server className="w-4 h-4 mt-0.5" style={{ color: "var(--text-muted)" }} />
            Nenhum VPS monitorado ainda. Cadastre em Sistema → VPS para receber alertas na dashboard, sino e Telegram.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <BriefMetric label="Online" value={`${onlineCount}/${hosts.length}`} color="var(--success)" />
              <BriefMetric label="Com atenção" value={String(problemHosts)} color={problemHosts > 0 ? statusColor : "var(--success)"} />
              <BriefMetric label="Alertas" value={String(warningCount)} color="var(--warning)" />
              <BriefMetric label="Críticos" value={String(criticalCount)} color="var(--error)" />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)] gap-3">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--text-muted)" }}>
                    VPS monitorados
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    passe o mouse para detalhes
                  </span>
                </div>
                <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                  {hostSummaries.map((summary) => (
                    <HostRow key={summary.host.vps_id} summary={summary} />
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--text-muted)" }}>
                    Alertas principais
                  </span>
                  {issues.length > 0 && (
                    <Link href="/system?tab=vps" className="text-[11px]" style={{ color: "var(--accent)" }}>
                      ver todos
                    </Link>
                  )}
                </div>
                <div className="max-h-[320px] overflow-y-auto pr-1">
                  {issues.length === 0 ? (
                    <div className="flex items-start gap-2 rounded-lg p-3" style={{ backgroundColor: "rgba(50,215,75,0.08)", color: "var(--text-secondary)" }}>
                      <CheckCircle2 className="w-4 h-4 mt-0.5" style={{ color: "var(--success)" }} />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                          Infra em ordem
                        </div>
                        <p className="text-xs mt-0.5">
                          Nenhum VPS offline, recurso crítico, serviço inativo ou container parado detectado.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {issues.slice(0, 8).map((issue, index) => (
                        <IssueRow key={`${issue.hostId}-${issue.label}-${index}`} issue={issue} />
                      ))}
                      {issues.length > 8 && (
                        <Link href="/system?tab=vps" className="block text-center text-[11px] py-1" style={{ color: "var(--accent)" }}>
                          Ver mais {issues.length - 8} alerta{issues.length - 8 === 1 ? "" : "s"} →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span>Alertas críticos também disparam sino e Telegram.</span>
              <span>{lastUpdated ? lastUpdated.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HostRow({ summary }: { summary: HostSummary }) {
  const host = summary.host;
  const metrics = host.last_snapshot?.metrics || {};
  const containers = host.last_snapshot?.docker?.containers || [];
  const downContainers = containers.filter((container) => container.state !== "running").length;
  const downServices = (host.last_snapshot?.services || []).filter((service) => !service.active).length;
  const tooltip = [
    host.hostname || host.name,
    `Status: ${host.status}`,
    `Último contato: ${formatLastSeen(host.last_seen_ms)}`,
    `CPU: ${typeof metrics.cpu_usage === "number" ? `${metrics.cpu_usage.toFixed(1)}%` : "—"}`,
    `RAM: ${typeof metrics.ram_used_pct === "number" ? `${metrics.ram_used_pct.toFixed(1)}%` : "—"}`,
    `Disco: ${typeof metrics.disk_used_pct === "number" ? `${metrics.disk_used_pct.toFixed(1)}%` : "—"}`,
    `Alertas: ${summary.issues.length}`,
  ].join("\n");

  return (
    <Link
      href={`/system?tab=vps&vps=${host.vps_id}`}
      title={tooltip}
      className="block rounded-xl p-3 transition-all hover:scale-[1.01]"
      style={{
        backgroundColor: summary.severity === "critical"
          ? "rgba(255,69,58,0.08)"
          : summary.severity === "warning"
            ? "rgba(255,214,10,0.07)"
            : "var(--card-elevated)",
        border: `1px solid ${summary.severity === "ok" ? "var(--border)" : severityColor(summary.severity)}`,
        textDecoration: "none",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {host.status === "online" ? (
              <Wifi className="w-4 h-4" style={{ color: severityColor(summary.severity) }} />
            ) : (
              <WifiOff className="w-4 h-4" style={{ color: severityColor(summary.severity) }} />
            )}
            <span className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
              {host.name}
            </span>
          </div>
          <div className="text-[11px] truncate mt-0.5" style={{ color: "var(--text-muted)" }}>
            {host.hostname || "sem hostname"} · visto {formatLastSeen(host.last_seen_ms)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summary.issues.length > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(255,255,255,0.06)", color: severityColor(summary.severity) }}>
              {summary.issues.length} alerta{summary.issues.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(255,255,255,0.04)", color: severityColor(summary.severity) }}>
            {summary.severity === "ok" ? "ok" : summary.severity}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <MetricMini label="CPU" value={metrics.cpu_usage} icon={Cpu} />
        <MetricMini label="RAM" value={metrics.ram_used_pct} icon={MemoryStick} />
        <MetricMini label="Disco" value={metrics.disk_used_pct} icon={HardDrive} />
      </div>

      {(containers.length > 0 || downServices > 0) && (
        <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {containers.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Boxes className="w-3 h-3" />
              {containers.length} container{containers.length === 1 ? "" : "s"}
              {downContainers > 0 ? ` · ${downContainers} parado${downContainers === 1 ? "" : "s"}` : ""}
            </span>
          )}
          {downServices > 0 && (
            <span className="inline-flex items-center gap-1" style={{ color: "var(--error)" }}>
              <AlertTriangle className="w-3 h-3" />
              {downServices} serviço{downServices === 1 ? "" : "s"} inativo{downServices === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

function MetricMini({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | undefined;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}) {
  const display = typeof value === "number" ? `${value.toFixed(0)}%` : "—";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-muted)" }}>
          <Icon className="w-3 h-3" />
          {label}
        </span>
        <span className="text-[11px] font-semibold" style={{ color: pctColor(value) }}>
          {display}
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "rgba(255,255,255,0.06)" }}>
        <div className="h-full rounded-full" style={{ width: `${typeof value === "number" ? Math.min(100, value) : 0}%`, backgroundColor: pctColor(value) }} />
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <Link
      href={`/system?tab=vps&vps=${issue.hostId}`}
      title={`${issue.hostName}\n${issue.label}\n${issue.detail}`}
      className="flex items-start gap-2 rounded-lg p-2.5 transition-all hover:scale-[1.01]"
      style={{
        backgroundColor: issue.severity === "critical" ? "rgba(255,69,58,0.08)" : "rgba(255,214,10,0.08)",
        border: "1px solid var(--border)",
        textDecoration: "none",
      }}
    >
      <AlertTriangle
        className="w-4 h-4 mt-0.5 flex-shrink-0"
        style={{ color: issue.severity === "critical" ? "var(--error)" : "var(--warning)" }}
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
          {issue.hostName} · {issue.label}
        </div>
        <div className="text-[11px] truncate" style={{ color: "var(--text-secondary)" }}>
          {issue.detail}
        </div>
      </div>
    </Link>
  );
}

function BriefMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg p-2" style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)" }}>
      <div className="text-lg font-bold" style={{ color, fontFamily: "var(--font-heading)" }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
    </div>
  );
}
