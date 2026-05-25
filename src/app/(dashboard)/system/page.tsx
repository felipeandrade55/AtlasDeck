"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Cpu, HardDrive, MemoryStick, Network, Server, ShieldCheck, RotateCw, Wifi, Monitor, Play, Square, X, Loader2, Terminal, ArrowDown, ArrowUp, Thermometer, Pause, RefreshCw, Trash2, Plus } from "lucide-react";
import { OpenClawConfigPanel } from "@/components/OpenClawConfigPanel";
import { MetricChart } from "@/components/system/MetricChart";
import type { RangeKey, SeriesResponse } from "@/lib/metrics-db";

const RANGE_OPTIONS: { id: RangeKey; label: string }[] = [
  { id: "3h", label: "3h" },
  { id: "12h", label: "12h" },
  { id: "24h", label: "24h" },
  { id: "72h", label: "72h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
];

// Recharts can't read CSS vars, so we mirror the theme tokens as hex.
const METRIC_PALETTE = {
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  info: "#3b82f6",
  accent: "#FF3B30",
};

function colorForPct(pct: number): string {
  if (pct < 60) return METRIC_PALETTE.success;
  if (pct < 85) return METRIC_PALETTE.warning;
  return METRIC_PALETTE.error;
}

type SystemTab = "hardware" | "services" | "openclaw";

interface SystemdService {
  name: string;
  status: string;
  description: string;
  backend?: string;
  uptime?: number | null;
  restarts?: number;
  pid?: number | null;
  mem?: number | null;
  cpu?: number | null;
}

interface TailscaleDevice {
  ip: string;
  hostname: string;
  os: string;
  online: boolean;
}

interface FirewallRule {
  id: string;
  port: string;
  action: string;
  from: string;
  comment: string;
}

interface SystemData {
  cpu: { usage: number; cores: number[]; loadAvg: number[]; temperature: number };
  ram: { total: number; used: number; free: number; cached: number };
  disk: { total: number; used: number; free: number; percent: number };
  network: { rx: number; tx: number };
  systemd: SystemdService[];
  tailscale: { active: boolean; backendState?: string; authUrl?: string; ip: string; devices: TailscaleDevice[]; rxBytes?: number; txBytes?: number };
  firewall: { active: boolean; rules: FirewallRule[]; ruleCount: number };
  fail2ban: { active: boolean; bannedIps: string[] };
}

interface LogsModal {
  name: string;
  backend: string;
  content: string;
  loading: boolean;
}

function SparklineChart({ rxHistory, txHistory }: { rxHistory: number[]; txHistory: number[] }) {
  const h = 44;
  const w = 200;
  const maxVal = Math.max(...rxHistory, ...txHistory, 0.1);
  const toPath = (data: number[]) => {
    if (data.length < 2) return "";
    return data.map((v, i) => {
      const x = ((i / (data.length - 1)) * w).toFixed(1);
      const y = (h - (v / maxVal) * h).toFixed(1);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    }).join(" ");
  };
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <path d={toPath(rxHistory)} fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={toPath(txHistory)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SystemMonitorPage() {
  const [systemData, setSystemData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedTab, setSelectedTab] = useState<SystemTab>("hardware");
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [logsModal, setLogsModal] = useState<LogsModal | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRulePort, setNewRulePort] = useState("");
  const [newRuleProtocol, setNewRuleProtocol] = useState("any");
  const [newRuleType, setNewRuleType] = useState("allow");
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Hardware time-series state
  const [range, setRange] = useState<RangeKey>(() => {
    if (typeof window === "undefined") return "24h";
    const stored = localStorage.getItem("system_hw_range") as RangeKey | null;
    return stored && RANGE_OPTIONS.some(r => r.id === stored) ? stored : "24h";
  });
  const [metricsData, setMetricsData] = useState<SeriesResponse | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("system_hw_range", range);
    }
  }, [range]);

  const fetchMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const res = await fetch(`/api/system/metrics?range=${range}`);
      if (res.ok) {
        const data = (await res.json()) as SeriesResponse;
        setMetricsData(data);
      }
    } catch (error) {
      console.error("Failed to fetch metrics:", error);
    } finally {
      setMetricsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    if (selectedTab !== "hardware") return;
    fetchMetrics();
  }, [selectedTab, fetchMetrics]);

  useEffect(() => {
    if (selectedTab !== "hardware" || !autoRefresh) return;
    const id = setInterval(fetchMetrics, 30_000);
    return () => clearInterval(id);
  }, [selectedTab, autoRefresh, fetchMetrics]);

  const fetchSystemData = async () => {
    try {
      const res = await fetch("/api/system/monitor");
      if (res.ok) {
        const data = await res.json();
        setSystemData(data);
        setLastUpdated(new Date());
      }
    } catch (error) {
      console.error("Failed to fetch system data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemData();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchSystemData, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // VPN traffic polling (every 2s when tailscale is active)
  useEffect(() => {
    if (!systemData?.tailscale.active) return;
    const poll = async () => {
      try {
        const res = await fetch("/api/system/tailscale");
        if (!res.ok) return;
        const d = await res.json();
        const rx = d.rxBytes ?? 0;
        const tx = d.txBytes ?? 0;
        const now = Date.now();
        if (prevVpnRef.current) {
          const dt = (now - prevVpnRef.current.ts) / 1000;
          if (dt > 0) {
            const rxRate = Math.max(0, (rx - prevVpnRef.current.rx) / dt / 1024);
            const txRate = Math.max(0, (tx - prevVpnRef.current.tx) / dt / 1024);
            setVpnHistory(prev => [...prev.slice(-59), { rx: rxRate, tx: txRate }]);
          }
        }
        prevVpnRef.current = { rx, tx, ts: now };
      } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [systemData?.tailscale.active]);

  // Handle Logs SSE Connection
  useEffect(() => {
    if (!logsModal?.name) return;
    
    const es = new EventSource(`/api/system/logs?name=${encodeURIComponent(logsModal.name)}&backend=${encodeURIComponent(logsModal.backend)}`);
    
    es.onmessage = (event) => {
      try {
        const text = JSON.parse(event.data);
        setLogsModal(prev => prev ? { ...prev, content: prev.content + text, loading: false } : null);
      } catch (e) {
        // ignore parse error
      }
    };

    es.onerror = () => {
      setLogsModal(prev => prev ? { ...prev, content: prev.content + "\n[Stream fechado ou erro de conexão]\n", loading: false } : null);
      es.close();
    };

    return () => {
      es.close();
    };
  }, [logsModal?.name, logsModal?.backend]);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logsModal?.content]);

  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleServiceAction = async (svc: SystemdService, action: "restart" | "stop" | "start" | "logs") => {
    if (action === "logs") {
      setLogsModal({ name: svc.name, backend: svc.backend || "pm2", content: "Conectando ao stream de logs...\n", loading: true });
      return;
    }

    const key = `${svc.name}-${action}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));

    try {
      const res = await fetch("/api/system/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: svc.name, backend: svc.backend || "pm2", action }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");

      showToast(`✅ ${svc.name}: ${action} successful`);
      setTimeout(fetchSystemData, 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      showToast(`❌ ${svc.name}: ${msg}`, "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleFirewallAction = async (action: 'enable' | 'disable' | 'add' | 'delete' | 'lockdown', id?: string) => {
    if (action === 'enable') {
      // Detecta a porta SSH real para mostrar no diálogo (evita ativar e perder acesso)
      let sshPorts: number[] = [22];
      try {
        const probe = await fetch('/api/system/firewall');
        if (probe.ok) {
          const data = await probe.json();
          if (Array.isArray(data.sshPorts) && data.sshPorts.length > 0) sshPorts = data.sshPorts;
        }
      } catch {
        // se a detecção falhar, segue com 22 e o usuário decide
      }
      const sshLines = sshPorts.map(p => `  • ${p}/tcp     → SSH (detectado)`).join('\n');
      const ok = window.confirm(
        'Ativar firewall (UFW)?\n\n' +
        'Antes do enable, serão liberadas as portas essenciais para você NÃO perder acesso:\n' +
        sshLines + '\n' +
        '  • 80/tcp     → HTTP\n' +
        '  • 443/tcp    → HTTPS\n' +
        '  • 41641/udp  → Tailscale (conexão direta)\n' +
        '  • tailscale0 → interface VPN\n\n' +
        'Saída de tráfego permanece livre (APIs OpenAI/Claude/etc. continuam funcionando).\n\n' +
        'Qualquer outra porta ficará BLOQUEADA. Confirmar?'
      );
      if (!ok) return;
    }
    setActionLoading(prev => ({ ...prev, firewall: true }));
    try {
      let res;
      if (action === 'delete') {
        res = await fetch(`/api/system/firewall?id=${id}`, { method: "DELETE" });
      } else {
        res = await fetch("/api/system/firewall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, port: newRulePort, protocol: newRuleProtocol, allowType: newRuleType }),
        });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ação do firewall falhou");

      showToast(`✅ Firewall: ${data.message}`);
      if (action === 'add') {
        setShowAddRule(false);
        setNewRulePort("");
      }
      setTimeout(fetchSystemData, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ação do firewall falhou";
      showToast(`❌ Firewall: ${msg}`, "error");
    } finally {
      setActionLoading(prev => ({ ...prev, firewall: false }));
    }
  };

  const [tailscaleAuthUrl, setTailscaleAuthUrl] = useState<string | null>(null);
  const [vpnHistory, setVpnHistory] = useState<{ rx: number; tx: number }[]>([]);
  const prevVpnRef = useRef<{ rx: number; tx: number; ts: number } | null>(null);

  const handleTailscaleAction = async (action: 'install' | 'up' | 'start' | 'stop' | 'restart' | 'allow_firewall') => {
    const key = `tailscale_${action}`;
    setActionLoading(prev => ({ ...prev, [key]: true, tailscale: true }));
    if (action !== 'stop') setTailscaleAuthUrl(null);
    try {
      const res = await fetch("/api/system/tailscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ação do Tailscale falhou");

      if (data.authUrl) {
        setTailscaleAuthUrl(data.authUrl);
        showToast("⚠️ Autenticação necessária — clique no link abaixo", "error");
      } else {
        showToast(`✅ Tailscale: ${data.message}`);
        setTimeout(fetchSystemData, 2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ação falhou";
      showToast(`❌ Tailscale: ${msg}`, "error");
    } finally {
      setActionLoading(prev => ({ ...prev, [key]: false, tailscale: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4" style={{ borderColor: "var(--accent)" }}></div>
          <p style={{ color: "var(--text-secondary)" }}>Carregando dados do sistema...</p>
        </div>
      </div>
    );
  }

  if (!systemData) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <Server className="w-16 h-16 mx-auto mb-4" style={{ color: "var(--text-muted)" }} />
          <p style={{ color: "var(--text-secondary)" }}>Falha ao carregar dados do sistema</p>
        </div>
      </div>
    );
  }

  const cpuColor = systemData.cpu.usage < 60 ? "var(--success)" : systemData.cpu.usage < 85 ? "var(--warning)" : "var(--error)";
  const ramPercent = (systemData.ram.used / systemData.ram.total) * 100;
  const ramColor = ramPercent < 60 ? "var(--success)" : ramPercent < 85 ? "var(--warning)" : "var(--error)";
  const diskColor = systemData.disk.percent < 60 ? "var(--success)" : systemData.disk.percent < 85 ? "var(--warning)" : "var(--error)";

  const activeServices = systemData.systemd.filter((s) => s.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: "1rem", right: "1rem", zIndex: 1000,
          padding: "0.75rem 1.25rem", borderRadius: "0.75rem",
          backgroundColor: toast.type === "success" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
          border: `1px solid ${toast.type === "success" ? "var(--success)" : "var(--error)"}`,
          color: toast.type === "success" ? "var(--success)" : "var(--error)",
          fontSize: "0.9rem", fontWeight: 500,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2" style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}>
            Monitor do Sistema
          </h1>
          <p style={{ color: "var(--text-secondary)" }}>Monitoramento em tempo real dos recursos e serviços do servidor</p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <button 
            onClick={() => fetchSystemData()} 
            className="p-1.5 rounded-md transition-colors hover:bg-white/5" 
            style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            title="Refresh Agora"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          
          <button 
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-all hover:opacity-90" 
            style={{ 
              backgroundColor: autoRefresh ? "rgba(34,197,94,0.12)" : "var(--card-elevated)", 
              color: autoRefresh ? "var(--success)" : "var(--text-muted)",
              border: autoRefresh ? "1px solid transparent" : "1px solid var(--border)"
            }}
            title={autoRefresh ? "Pausar Auto-Refresh" : "Ativar Auto-Refresh"}
          >
            {autoRefresh ? (
              <><span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: "var(--success)" }} /> Live</>
            ) : (
              <><Pause className="w-3 h-3" /> Pausado</>
            )}
          </button>
          {lastUpdated && (
            <span className="text-xs ml-1" style={{ color: "var(--text-muted)" }}>{lastUpdated.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b" style={{ borderColor: "var(--border)" }}>
        {[
          { id: "hardware", label: "Hardware", icon: Cpu },
          { id: "services", label: "Serviços", icon: Server },
          { id: "openclaw", label: "OpenClaw", icon: Terminal },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = selectedTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSelectedTab(tab.id as SystemTab)}
              className="flex items-center gap-2 px-4 py-2 font-medium transition-all"
              style={{ color: isActive ? "var(--accent)" : "var(--text-secondary)", borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent" }}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Hardware Tab */}
      {selectedTab === "hardware" && (
        <div className="space-y-4">
          {/* Range selector */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1 p-1 rounded-full" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              {RANGE_OPTIONS.map(opt => {
                const active = range === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setRange(opt.id)}
                    className="px-3 py-1 text-xs font-medium rounded-full transition-all"
                    style={{
                      backgroundColor: active ? "var(--accent)" : "transparent",
                      color: active ? "#fff" : "var(--text-secondary)",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <div className="text-xs flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
              {metricsLoading && <Loader2 className="w-3 h-3 animate-spin" />}
              {metricsData && (
                <span>
                  resolução {metricsData.bucket === "raw" ? "30s" : metricsData.bucket} ·{" "}
                  {(metricsData.metrics.cpu_usage?.length ?? 0)} pontos
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* CPU */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                    <Cpu className="w-5 h-5" style={{ color: cpuColor }} />
                  </div>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>CPU</h3>
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{systemData.cpu.cores.length} cores</p>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-2xl font-bold" style={{ color: cpuColor }}>{systemData.cpu.usage}%</span>
                  {systemData.cpu.temperature > 0 && (
                    <div className="flex items-center gap-1 mt-1 text-xs font-medium px-2 py-0.5 rounded" style={{ backgroundColor: systemData.cpu.temperature > 80 ? "var(--error-bg)" : "var(--card-elevated)", color: systemData.cpu.temperature > 80 ? "var(--error)" : "var(--text-secondary)" }}>
                      <Thermometer className="w-3 h-3" />
                      {systemData.cpu.temperature}°C
                    </div>
                  )}
                </div>
              </div>
              <div className="h-2 rounded-full overflow-hidden mb-3" style={{ backgroundColor: "var(--card-elevated)" }}>
                <div className="h-full transition-all duration-500" style={{ width: `${systemData.cpu.usage}%`, backgroundColor: cpuColor }} />
              </div>
              <div className="flex justify-between text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
                <span>Carga Média</span>
                <span>{systemData.cpu.loadAvg[0]?.toFixed(2)} / {systemData.cpu.loadAvg[1]?.toFixed(2)} / {systemData.cpu.loadAvg[2]?.toFixed(2)}</span>
              </div>
              <MetricChart
                data={metricsData?.metrics.cpu_usage ?? []}
                color={colorForPct(systemData.cpu.usage)}
                unit="%"
                label="CPU"
                yDomain={[0, 100]}
              />
            </div>

            {/* RAM */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                    <MemoryStick className="w-5 h-5" style={{ color: ramColor }} />
                  </div>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>RAM</h3>
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{systemData.ram.used.toFixed(1)}GB / {systemData.ram.total.toFixed(1)}GB</p>
                  </div>
                </div>
                <span className="text-2xl font-bold" style={{ color: ramColor }}>{ramPercent.toFixed(0)}%</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden mb-3" style={{ backgroundColor: "var(--card-elevated)" }}>
                <div className="h-full transition-all duration-500" style={{ width: `${ramPercent}%`, backgroundColor: ramColor }} />
              </div>
              <MetricChart
                data={metricsData?.metrics.ram_used_pct ?? []}
                color={colorForPct(ramPercent)}
                unit="%"
                label="RAM"
                yDomain={[0, 100]}
              />
            </div>

            {/* Disk */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                    <HardDrive className="w-5 h-5" style={{ color: diskColor }} />
                  </div>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Disk</h3>
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{systemData.disk.used.toFixed(1)}GB / {systemData.disk.total.toFixed(1)}GB</p>
                  </div>
                </div>
                <span className="text-2xl font-bold" style={{ color: diskColor }}>{systemData.disk.percent.toFixed(0)}%</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden mb-3" style={{ backgroundColor: "var(--card-elevated)" }}>
                <div className="h-full transition-all duration-500" style={{ width: `${systemData.disk.percent}%`, backgroundColor: diskColor }} />
              </div>
              <MetricChart
                data={metricsData?.metrics.disk_used_pct ?? []}
                color={colorForPct(systemData.disk.percent)}
                unit="%"
                label="Disk"
                yDomain={[0, 100]}
              />
            </div>

            {/* Network */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                  <Network className="w-5 h-5" style={{ color: METRIC_PALETTE.info }} />
                </div>
                <div>
                  <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Network</h3>
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Live I/O</p>
                </div>
              </div>
              <div className="space-y-2 mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
                    <ArrowDown className="w-4 h-4" style={{ color: "var(--success)" }} />
                    <span>RX (in)</span>
                  </div>
                  <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>{systemData.network.rx.toFixed(2)} MB/s</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
                    <ArrowUp className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    <span>TX (out)</span>
                  </div>
                  <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>{systemData.network.tx.toFixed(2)} MB/s</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>RX</div>
                  <MetricChart
                    data={metricsData?.metrics.net_rx_mbps ?? []}
                    color={METRIC_PALETTE.success}
                    unit=" MB/s"
                    label="RX"
                    height={100}
                    precision={2}
                    showStats={false}
                  />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>TX</div>
                  <MetricChart
                    data={metricsData?.metrics.net_tx_mbps ?? []}
                    color={METRIC_PALETTE.accent}
                    unit=" MB/s"
                    label="TX"
                    height={100}
                    precision={2}
                    showStats={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedTab === "openclaw" && (
        <OpenClawConfigPanel />
      )}

      {/* Services Tab */}
      {selectedTab === "services" && (
        <div className="space-y-6">
          {/* Systemd + PM2 + Docker Services */}
          <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
              <Server className="w-5 h-5" style={{ color: "var(--accent)" }} />
              Serviços ({activeServices}/{systemData.systemd.length} ativos)
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th className="text-left py-2 px-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Serviço</th>
                    <th className="text-left py-2 px-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Descrição</th>
                    <th className="text-left py-2 px-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Status</th>
                    <th className="text-right py-2 px-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {systemData.systemd.map((svc) => {
                    const isActionable = svc.backend === "pm2" || svc.backend === "systemd" || svc.backend === "docker";
                    const restartKey = `${svc.name}-restart`;
                    const stopKey = `${svc.name}-stop`;
                    const logsKey = `${svc.name}-logs`;

                    return (
                      <tr key={svc.name} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td className="py-3 px-3">
                          <span className="font-mono font-medium" style={{ color: "var(--text-primary)" }}>{svc.name}</span>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm" style={{ color: "var(--text-secondary)", maxWidth: "300px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={svc.description}>{svc.description || "—"}</span>
                            {svc.uptime != null && svc.status === "active" && (
                              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                                up {formatUptime(svc.uptime)}
                                {svc.restarts != null && svc.restarts > 0 && ` · ${svc.restarts} restarts`}
                                {svc.mem != null && ` · ${formatBytes(svc.mem)}`}
                                {svc.cpu != null && ` · ${svc.cpu.toFixed(1)}% CPU`}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{
                                backgroundColor:
                                  svc.status === "active" ? "var(--success)" :
                                  svc.status === "not_deployed" ? "var(--info, #3b82f6)" :
                                  svc.status === "failed" ? "var(--error)" : "var(--text-muted)",
                              }}
                            />
                            <span
                              className="px-2 py-1 rounded text-xs font-medium"
                              style={{
                                backgroundColor:
                                  svc.status === "active" ? "var(--success-bg)" :
                                  svc.status === "not_deployed" ? "rgba(59,130,246,0.12)" :
                                  svc.status === "failed" ? "var(--error-bg)" : "var(--card-elevated)",
                                color:
                                  svc.status === "active" ? "var(--success)" :
                                  svc.status === "not_deployed" ? "#60a5fa" :
                                  svc.status === "failed" ? "var(--error)" : "var(--text-muted)",
                              }}
                            >
                              {svc.status === "not_deployed" ? "not deployed" : svc.status}
                            </span>
                            {svc.backend && svc.backend !== "none" && (
                              <span
                                className="px-1.5 py-0.5 rounded text-xs uppercase"
                                style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-muted)", fontSize: "9px", letterSpacing: "0.05em" }}
                              >
                                {svc.backend}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex justify-end gap-1">
                            {isActionable && (
                              <>
                                {/* Restart */}
                                <button
                                  onClick={() => handleServiceAction(svc, "restart")}
                                  disabled={actionLoading[restartKey]}
                                  className="p-1.5 rounded transition-colors hover:bg-white/5"
                                  title="Restart"
                                  style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                                >
                                  {actionLoading[restartKey] ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RotateCw className="w-4 h-4" />
                                  )}
                                </button>

                                {/* Stop/Start */}
                                <button
                                  onClick={() => handleServiceAction(svc, svc.status === "active" ? "stop" : "start")}
                                  disabled={actionLoading[stopKey] || svc.status === "not_deployed"}
                                  className="p-1.5 rounded transition-colors hover:bg-white/5"
                                  title={svc.status === "active" ? "Stop" : "Start"}
                                  style={{ color: svc.status === "active" ? "var(--error)" : "var(--success)", background: "none", border: "none", cursor: "pointer" }}
                                >
                                  {svc.status === "active" ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                </button>

                                {/* Logs */}
                                <button
                                  onClick={() => handleServiceAction(svc, "logs")}
                                  disabled={actionLoading[logsKey]}
                                  className="p-1.5 rounded transition-colors hover:bg-white/5"
                                  title="View Live Logs"
                                  style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                                >
                                  {actionLoading[logsKey] ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Terminal className="w-4 h-4" />
                                  )}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* VPN & Firewall */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Tailscale VPN */}
            {(() => {
              const ts = systemData.tailscale;
              const bs = ts.backendState || (ts.active ? "Running" : "NotInstalled");
              const activeAuthUrl = tailscaleAuthUrl || ts.authUrl || null;
              const statusColor = bs === "Running" ? "var(--success)" : bs === "NeedsLogin" ? "#f59e0b" : "var(--error)";
              const statusLabel = bs === "Running" ? "Ativo" : bs === "NeedsLogin" ? "Login Necessário" : bs === "Stopped" ? "Parado" : bs === "NotInstalled" ? "Não instalado" : "Inativo";
              const rxNow = vpnHistory.length > 0 ? vpnHistory[vpnHistory.length - 1].rx : 0;
              const txNow = vpnHistory.length > 0 ? vpnHistory[vpnHistory.length - 1].tx : 0;
              return (
                <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
                  {/* Header row */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                        <Wifi className="w-5 h-5" style={{ color: statusColor }} />
                      </div>
                      <div>
                        <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Tailscale VPN</h3>
                        <p className="text-sm font-medium" style={{ color: statusColor }}>{statusLabel}</p>
                      </div>
                    </div>
                    {/* Service controls */}
                    {(bs === "Running" || bs === "Stopped" || bs === "NeedsLogin") && (
                      <div className="flex items-center gap-1">
                        {bs === "Running" && (
                          <>
                            <button
                              onClick={() => handleTailscaleAction("restart")}
                              disabled={!!actionLoading[`tailscale_restart`]}
                              className="p-1.5 rounded transition-colors hover:bg-white/5"
                              title="Reiniciar"
                              style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                            >
                              {actionLoading[`tailscale_restart`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                            </button>
                            <button
                              onClick={() => handleTailscaleAction("stop")}
                              disabled={!!actionLoading[`tailscale_stop`]}
                              className="p-1.5 rounded transition-colors hover:bg-white/5"
                              title="Parar"
                              style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}
                            >
                              {actionLoading[`tailscale_stop`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                            </button>
                          </>
                        )}
                        {(bs === "Stopped" || bs === "NeedsLogin") && (
                          <button
                            onClick={() => handleTailscaleAction("start")}
                            disabled={!!actionLoading[`tailscale_start`]}
                            className="p-1.5 rounded transition-colors hover:bg-white/5"
                            title="Iniciar"
                            style={{ color: "var(--success)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            {actionLoading[`tailscale_start`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Info rows */}
                  {ts.ip && (
                    <div className="flex justify-between text-sm mb-1">
                      <span style={{ color: "var(--text-secondary)" }}>Este servidor</span>
                      <span className="font-mono" style={{ color: "var(--text-primary)" }}>{ts.ip}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm mb-3">
                    <span style={{ color: "var(--text-secondary)" }}>Dispositivos conectados</span>
                    <span style={{ color: "var(--text-primary)" }}>{ts.devices.length}</span>
                  </div>

                  {/* Traffic graph */}
                  {bs === "Running" && (
                    <div className="mb-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span style={{ color: "var(--text-muted)" }}>Tráfego VPN (tempo real)</span>
                        <div className="flex gap-3">
                          <span style={{ color: "var(--success)" }}>↓ {rxNow.toFixed(1)} KB/s</span>
                          <span style={{ color: "var(--accent)" }}>↑ {txNow.toFixed(1)} KB/s</span>
                        </div>
                      </div>
                      <div className="rounded overflow-hidden" style={{ backgroundColor: "var(--card-elevated)" }}>
                        <SparklineChart
                          rxHistory={vpnHistory.map(p => p.rx)}
                          txHistory={vpnHistory.map(p => p.tx)}
                        />
                      </div>
                      <div className="flex gap-4 mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                        <span className="flex items-center gap-1"><span style={{ color: "var(--success)" }}>—</span> RX (entrada)</span>
                        <span className="flex items-center gap-1"><span style={{ color: "var(--accent)" }}>—</span> TX (saída)</span>
                      </div>
                    </div>
                  )}

                  {/* Device list */}
                  {ts.devices.length > 0 && (
                    <div className="space-y-2 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                      {ts.devices.map((dev, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <Monitor className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                            <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{dev.hostname}</span>
                            <span style={{ color: "var(--text-muted)" }}>({dev.os})</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono" style={{ color: "var(--text-muted)" }}>{dev.ip}</span>
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dev.online ? "var(--success)" : "var(--text-muted)" }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Auth URL */}
                  {activeAuthUrl && (
                    <div className="mt-3 p-3 rounded-lg" style={{ backgroundColor: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)" }}>
                      <p className="text-xs mb-2 font-semibold" style={{ color: "#fbbf24" }}>Autenticação necessária — abra o link no navegador:</p>
                      <a href={activeAuthUrl} target="_blank" rel="noreferrer"
                        className="text-xs font-mono break-all hover:underline"
                        style={{ color: "#60a5fa" }}>
                        {activeAuthUrl}
                      </a>
                    </div>
                  )}

                  {/* Install / Login buttons when not running */}
                  {bs === "NotInstalled" && (
                    <div className="mt-4 pt-4 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
                      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                        Instale o Tailscale para criar uma VPN privada zero-config. O firewall será configurado automaticamente.
                      </p>
                      <button
                        onClick={() => handleTailscaleAction("install")}
                        disabled={!!actionLoading[`tailscale_install`]}
                        className="w-full py-1.5 rounded text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        style={{ backgroundColor: "var(--accent)", color: "white" }}
                      >
                        {actionLoading[`tailscale_install`] ? <Loader2 className="w-3 h-3 animate-spin" /> : "Instalar Tailscale"}
                      </button>
                    </div>
                  )}

                  {(bs === "Stopped" || bs === "NeedsLogin") && !activeAuthUrl && (
                    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                      <button
                        onClick={() => handleTailscaleAction("start")}
                        disabled={!!actionLoading[`tailscale_start`]}
                        className="w-full py-1.5 rounded text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        style={{ backgroundColor: "#3b82f6", color: "white" }}
                      >
                        {actionLoading[`tailscale_start`] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        {bs === "NeedsLogin" ? "Entrar na conta Tailscale" : "Iniciar Tailscale"}
                      </button>
                    </div>
                  )}

                  {/* Firewall allow button */}
                  {bs === "Running" && (
                    <div className="mt-3">
                      <button
                        onClick={() => handleTailscaleAction("allow_firewall")}
                        disabled={!!actionLoading[`tailscale_allow_firewall`]}
                        className="w-full py-1.5 rounded text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                        style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                      >
                        {actionLoading[`tailscale_allow_firewall`] ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                        Permitir Tailscale no Firewall
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Firewall */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                    <ShieldCheck className="w-5 h-5" style={{ color: systemData.firewall.active ? "var(--success)" : "var(--error)" }} />
                  </div>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Firewall (UFW)</h3>
                    <div className="flex items-center gap-2">
                      <span className="text-sm" style={{ color: systemData.firewall.active ? "var(--success)" : "var(--error)" }}>
                        {systemData.firewall.active ? "Ativo" : "Inativo"}
                      </span>
                      <button
                        onClick={() => handleFirewallAction(systemData.firewall.active ? 'disable' : 'enable')}
                        disabled={actionLoading.firewall}
                        className="text-xs font-semibold px-2 py-0.5 rounded transition-colors hover:opacity-80 disabled:opacity-50"
                        style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-primary)" }}
                      >
                        {systemData.firewall.active ? "Desativar" : "Ativar"}
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setShowAddRule(!showAddRule)}
                  className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
                  style={{ backgroundColor: "var(--card-elevated)", color: "var(--accent)", border: "1px solid var(--border)" }}
                >
                  {showAddRule ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                </button>
              </div>

              {systemData.tailscale.active && systemData.firewall.active && (
                <div className="mb-4 p-3 rounded-lg" style={{ backgroundColor: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)" }}>
                  <p className="text-xs mb-2" style={{ color: "#93c5fd" }}>
                    <strong>Tailscale Ativo!</strong> Você pode remover o acesso público das portas (3000, 22, 18789) e permitir tráfego apenas pela VPN privada com um clique.
                  </p>
                  <button
                    onClick={() => handleFirewallAction('lockdown')}
                    disabled={actionLoading.firewall}
                    className="w-full py-1.5 rounded text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ backgroundColor: "#3b82f6", color: "white" }}
                  >
                    {actionLoading.firewall ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                    Ativar Lockdown (Apenas VPN)
                  </button>
                </div>
              )}

              {showAddRule && (
                <div className="mb-4 p-3 rounded-lg space-y-3" style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)" }}>
                  <div className="grid grid-cols-3 gap-2">
                    <input 
                      placeholder="Porta (ex: 8080)" 
                      value={newRulePort} 
                      onChange={e => setNewRulePort(e.target.value)}
                      className="text-xs px-2 py-1.5 rounded bg-black/20 border border-white/10 outline-none text-white font-mono"
                    />
                    <select 
                      value={newRuleProtocol} 
                      onChange={e => setNewRuleProtocol(e.target.value)}
                      className="text-xs px-2 py-1.5 rounded bg-black/20 border border-white/10 outline-none text-white"
                    >
                      <option value="any">Qualquer</option>
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                    <select 
                      value={newRuleType} 
                      onChange={e => setNewRuleType(e.target.value)}
                      className="text-xs px-2 py-1.5 rounded bg-black/20 border border-white/10 outline-none text-white"
                    >
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                    </select>
                  </div>
                  <button 
                    onClick={() => handleFirewallAction('add')}
                    disabled={actionLoading.firewall || !newRulePort}
                    className="w-full py-1.5 rounded text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={{ backgroundColor: "var(--accent)", color: "white" }}
                  >
                    Salvar Regra
                  </button>
                </div>
              )}

              <div className="space-y-2">
                {systemData.firewall.rules.map((rule, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-xs py-1.5 group"
                    style={{ borderBottom: i < systemData.firewall.rules.length - 1 ? "1px solid var(--border)" : "none" }}
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>{rule.port}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{ backgroundColor: rule.action.includes("ALLOW") ? "var(--success-bg)" : "var(--error-bg)", color: rule.action.includes("ALLOW") ? "var(--success)" : "var(--error)" }}>
                          {rule.action}
                        </span>
                        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                          {rule.from}
                        </span>
                      </div>
                      {rule.comment && <span style={{ color: "var(--text-muted)", fontSize: "10px" }}>{rule.comment}</span>}
                    </div>
                    <button
                      onClick={() => handleFirewallAction('delete', rule.id)}
                      disabled={actionLoading.firewall}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all hover:bg-red-500/20 disabled:opacity-0"
                      style={{ color: "var(--error)" }}
                      title="Deletar Regra"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {systemData.firewall.rules.length === 0 && (
                  <div className="text-xs text-center py-2" style={{ color: "var(--text-muted)" }}>
                    Nenhuma regra configurada.
                  </div>
                )}
              </div>
            </div>

            {/* Fail2Ban */}
            <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated)" }}>
                  <ShieldCheck className="w-5 h-5" style={{ color: systemData.fail2ban.active ? "var(--success)" : "var(--error)" }} />
                </div>
                <div>
                  <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>Fail2Ban (Anti-Brute Force)</h3>
                  <p className="text-sm" style={{ color: systemData.fail2ban.active ? "var(--success)" : "var(--error)" }}>
                    {systemData.fail2ban.active ? "Ativo e Protegendo" : "Inativo"}
                  </p>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                  <span style={{ color: "var(--text-secondary)" }}>IPs Banidos Atualmente</span>
                  <span className="font-bold" style={{ color: systemData.fail2ban.bannedIps.length > 0 ? "var(--error)" : "var(--success)" }}>
                    {systemData.fail2ban.bannedIps.length}
                  </span>
                </div>
              </div>
              {systemData.fail2ban.bannedIps.length > 0 && (
                <div className="space-y-2 pt-3" style={{ borderTop: "1px solid var(--border)", maxHeight: "150px", overflowY: "auto" }}>
                  {systemData.fail2ban.bannedIps.map((ip, i) => (
                    <div key={i} className="flex items-center justify-between text-xs py-1">
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "var(--error)" }} />
                        <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>{ip}</span>
                      </div>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{ backgroundColor: "var(--error-bg)", color: "var(--error)" }}>
                        BANNED
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {logsModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          backgroundColor: "rgba(0,0,0,0.85)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "1rem",
        }}>
          <div style={{
            width: "95vw", maxWidth: "900px", height: "80vh",
            backgroundColor: "#0d1117",
            borderRadius: "1rem", border: "1px solid var(--border)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
          }}>
            {/* Log header */}
            <div style={{
              display: "flex", alignItems: "center", gap: "0.75rem",
              padding: "0.875rem 1rem",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}>
              <Terminal className="w-4 h-4" style={{ color: "var(--accent)" }} />
              <span style={{ color: "#c9d1d9", fontFamily: "monospace", fontSize: "0.9rem" }}>
                {logsModal.name} logs
              </span>
              <span style={{ fontSize: "0.75rem", color: "#8b949e", marginLeft: "0.5rem", textTransform: "uppercase" }}>
                ({logsModal.backend})
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium uppercase" style={{ backgroundColor: "rgba(34,197,94,0.12)", color: "var(--success)" }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: "var(--success)" }} />
                  Live Stream
                </span>
                <button
                  onClick={() => setLogsModal(null)}
                  className="p-1.5 rounded-md transition-colors hover:bg-white/10"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#8b949e" }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Log content */}
            <div style={{ flex: 1, overflow: "auto", padding: "1rem" }}>
              <pre style={{
                fontFamily: "monospace", fontSize: "0.8rem",
                color: "#c9d1d9", whiteSpace: "pre-wrap", wordBreak: "break-all",
                lineHeight: 1.6,
              }}>
                {logsModal.content || "Aguardando logs..."}
                <div ref={logsEndRef} />
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
