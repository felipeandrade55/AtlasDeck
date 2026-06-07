"use client";

import { useEffect, useState } from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  ArrowDownUp,
  Boxes,
  Server,
  Settings,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { MetricChart } from "@/components/system/MetricChart";
import type { AggPoint } from "@/lib/metrics-db";
import type { VpsHost, VpsThresholds, MonitoredService } from "./types";
import { relativeTime, statusColor, statusLabel } from "./types";

type RangeKey = "3h" | "12h" | "24h" | "72h" | "7d" | "30d";
const RANGE_OPTIONS: { id: RangeKey; label: string }[] = [
  { id: "3h", label: "3h" },
  { id: "12h", label: "12h" },
  { id: "24h", label: "24h" },
  { id: "72h", label: "72h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
];

const COLORS = { cpu: "#3b82f6", ram: "#22c55e", swap: "#a855f7", disk: "#f59e0b", net: "#06b6d4", load: "#ef4444" };

interface SeriesResponse {
  metrics: Record<string, AggPoint[]>;
}

export function VpsDetail({
  host,
  onChanged,
  onDeleted,
}: {
  host: VpsHost;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [range, setRange] = useState<RangeKey>("24h");
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const vpsId = host.vps_id;
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const res = await fetch(`/api/vps/${vpsId}/metrics?range=${range}`);
        if (active && res.ok) setSeries(await res.json());
      } catch {
        // silent
      }
    };
    run();
    const id = setInterval(run, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [vpsId, range]);

  const snap = host.last_snapshot || {};
  const m = snap.metrics || {};
  const get = (k: string): AggPoint[] => series?.metrics?.[k] || [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-4" style={{ backgroundColor: "color-mix(in srgb, var(--card) 60%, transparent)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor(host.status) }} />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate" style={{ color: "var(--text-primary)" }}>
              {host.name}
            </h2>
            <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
              {host.hostname || "—"} · {host.os || "—"} · agente {host.agent_version || "?"} ·{" "}
              <span style={{ color: statusColor(host.status) }}>{statusLabel(host.status)}</span> · {relativeTime(host.last_seen_ms)}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowConfig((s) => !s)}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg"
          style={{ backgroundColor: showConfig ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--card-elevated)", color: showConfig ? "var(--accent)" : "var(--text-secondary)", border: "1px solid var(--border)" }}
        >
          <Settings className="w-4 h-4" />
          Configurar
        </button>
      </div>

      {showConfig && <ConfigPanel host={host} onChanged={onChanged} onDeleted={onDeleted} />}

      {/* Range selector */}
      <div className="flex items-center gap-1 p-1 rounded-full w-fit" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setRange(opt.id)}
            className="px-3 py-1 text-xs font-medium rounded-full"
            style={{ backgroundColor: range === opt.id ? "var(--accent)" : "transparent", color: range === opt.id ? "white" : "var(--text-secondary)" }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <ChartCard title="CPU" icon={Cpu} current={fmtPct(m.cpu_usage)}>
          <MetricChart data={get("cpu_usage")} color={COLORS.cpu} unit="%" yDomain={[0, 100]} label="CPU" />
        </ChartCard>
        <ChartCard title="Memória RAM" icon={MemoryStick} current={fmtPct(m.ram_used_pct)}>
          <MetricChart data={get("ram_used_pct")} color={COLORS.ram} unit="%" yDomain={[0, 100]} label="RAM" />
        </ChartCard>
        <ChartCard title="Swap" icon={MemoryStick} current={fmtPct(m.swap_used_pct)}>
          <MetricChart data={get("swap_used_pct")} color={COLORS.swap} unit="%" yDomain={[0, 100]} label="Swap" />
        </ChartCard>
        <ChartCard title="Disco" icon={HardDrive} current={fmtPct(m.disk_used_pct)}>
          <MetricChart data={get("disk_used_pct")} color={COLORS.disk} unit="%" yDomain={[0, 100]} label="Disco" />
        </ChartCard>
        <ChartCard title="Rede ↓ (RX)" icon={ArrowDownUp} current={`${(m.net_rx_mbps ?? 0).toFixed(2)} MB/s`}>
          <MetricChart data={get("net_rx_mbps")} color={COLORS.net} unit=" MB/s" precision={2} label="RX" />
        </ChartCard>
        <ChartCard title="Rede ↑ (TX)" icon={ArrowDownUp} current={`${(m.net_tx_mbps ?? 0).toFixed(2)} MB/s`}>
          <MetricChart data={get("net_tx_mbps")} color={COLORS.net} unit=" MB/s" precision={2} label="TX" />
        </ChartCard>
        <ChartCard title="Carga (1m)" icon={Activity} current={(m.load1 ?? 0).toFixed(2)}>
          <MetricChart data={get("load1")} color={COLORS.load} unit="" precision={2} label="load1" />
        </ChartCard>
      </div>

      {/* Top processes */}
      <Panel title="Processos (Top)" icon={Activity}>
        {snap.processes && snap.processes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: "var(--text-muted)" }} className="text-left text-xs uppercase">
                  <th className="py-1.5 pr-3">Processo</th>
                  <th className="py-1.5 px-3">PID</th>
                  <th className="py-1.5 px-3 text-right">CPU</th>
                  <th className="py-1.5 pl-3 text-right">Mem</th>
                </tr>
              </thead>
              <tbody>
                {snap.processes.slice(0, 10).map((p) => (
                  <tr key={p.pid} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="py-1.5 pr-3 truncate max-w-[260px]" style={{ color: "var(--text-primary)" }} title={p.cmd}>
                      {p.name}
                    </td>
                    <td className="py-1.5 px-3" style={{ color: "var(--text-muted)" }}>{p.pid}</td>
                    <td className="py-1.5 px-3 text-right font-semibold" style={{ color: pctColor(p.cpu) }}>{p.cpu.toFixed(1)}%</td>
                    <td className="py-1.5 pl-3 text-right" style={{ color: "var(--text-secondary)" }}>{p.memPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sem dados de processos ainda.</Empty>
        )}
      </Panel>

      {/* Docker */}
      <Panel
        title="Docker"
        icon={Boxes}
        right={
          snap.docker
            ? snap.docker.installed
              ? snap.docker.running
                ? <Badge color="var(--success)">daemon ativo</Badge>
                : <Badge color="var(--error)">daemon parado</Badge>
              : <Badge color="var(--text-muted)">não instalado</Badge>
            : null
        }
      >
        {snap.docker?.installed && (snap.docker.containers?.length ?? 0) > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: "var(--text-muted)" }} className="text-left text-xs uppercase">
                  <th className="py-1.5 pr-3">Container</th>
                  <th className="py-1.5 px-3">Imagem</th>
                  <th className="py-1.5 px-3">Estado</th>
                  <th className="py-1.5 px-3 text-right">CPU</th>
                  <th className="py-1.5 pl-3 text-right">Mem</th>
                </tr>
              </thead>
              <tbody>
                {snap.docker.containers!.map((c) => (
                  <tr key={c.name} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="py-1.5 pr-3 truncate max-w-[180px]" style={{ color: "var(--text-primary)" }}>{c.name}</td>
                    <td className="py-1.5 px-3 truncate max-w-[160px]" style={{ color: "var(--text-muted)" }}>{c.image || "—"}</td>
                    <td className="py-1.5 px-3">
                      <span className="inline-flex items-center gap-1" style={{ color: c.state === "running" ? "var(--success)" : "var(--error)" }}>
                        {c.state === "running" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        {c.state}
                      </span>
                    </td>
                    <td className="py-1.5 px-3 text-right" style={{ color: "var(--text-secondary)" }}>{c.cpu != null ? `${c.cpu.toFixed(1)}%` : "—"}</td>
                    <td className="py-1.5 pl-3 text-right" style={{ color: "var(--text-secondary)" }}>{c.memPct != null ? `${c.memPct.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{snap.docker?.installed ? "Nenhum container." : "Docker não detectado neste VPS."}</Empty>
        )}
      </Panel>

      {/* Disks + services side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <Panel title="Discos" icon={HardDrive}>
          {snap.disks && snap.disks.length > 0 ? (
            <div className="space-y-2">
              {snap.disks.map((d) => (
                <div key={d.mount}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span style={{ color: "var(--text-secondary)" }}>{d.mount}</span>
                    <span style={{ color: pctColor(d.pct) }}>{d.usedGb}/{d.totalGb} GB ({d.pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--card-elevated)" }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, d.pct)}%`, backgroundColor: pctColor(d.pct) }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Sem dados de disco.</Empty>
          )}
        </Panel>

        <Panel title="Serviços monitorados" icon={Server}>
          {snap.services && snap.services.length > 0 ? (
            <div className="space-y-1.5">
              {snap.services.map((s) => (
                <div key={s.name} className="flex items-center justify-between text-sm">
                  <span style={{ color: "var(--text-primary)" }}>{s.name}</span>
                  <span className="inline-flex items-center gap-1 text-xs" style={{ color: s.active ? "var(--success)" : "var(--error)" }}>
                    {s.active ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                    {s.active ? "ativo" : "inativo"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Nenhum serviço systemd configurado. Adicione em Configurar.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ── Config panel ──────────────────────────────────────────────────── */

function ConfigPanel({ host, onChanged, onDeleted }: { host: VpsHost; onChanged: () => void; onDeleted: () => void }) {
  const [thresholds, setThresholds] = useState<VpsThresholds>(host.thresholds);
  const [services, setServices] = useState<MonitoredService[]>(host.monitored_services);
  const [monitorDocker, setMonitorDocker] = useState(host.monitor_docker);
  const [newService, setNewService] = useState("");
  const [newToken, setNewToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { thresholds, monitored_services: services, monitor_docker: monitorDocker };
      if (newToken.trim()) body.token = newToken.trim();
      const res = await fetch(`/api/vps/${host.vps_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao salvar");
      setMsg("Configuração salva.");
      setNewToken("");
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remover o VPS "${host.name}"? As métricas dele serão apagadas.`)) return;
    await fetch(`/api/vps/${host.vps_id}`, { method: "DELETE" });
    onDeleted();
  };

  return (
    <div className="rounded-xl p-4 space-y-4" style={{ backgroundColor: "color-mix(in srgb, var(--card) 40%, transparent)", border: "1px solid var(--border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Limites de alerta (%)</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {(["cpu", "ram", "swap", "disk"] as const).map((k) => (
          <ThresholdInput key={k} label={k.toUpperCase()} pair={thresholds[k]} onChange={(p) => setThresholds({ ...thresholds, [k]: p })} />
        ))}
        <ThresholdInput label="LOAD/core" pair={thresholds.load1PerCore} step={0.1} onChange={(p) => setThresholds({ ...thresholds, load1PerCore: p })} />
        <div>
          <label className="block text-[11px] uppercase mb-1" style={{ color: "var(--text-muted)" }}>Offline após (s)</label>
          <input
            type="number"
            value={thresholds.offlineSec}
            onChange={(e) => setThresholds({ ...thresholds, offlineSec: Number(e.target.value) })}
            className="w-full text-sm rounded-lg px-2 py-1.5"
            style={inputStyle}
          />
        </div>
      </div>

      {/* Docker toggle */}
      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-primary)" }}>
        <input type="checkbox" checked={monitorDocker} onChange={(e) => setMonitorDocker(e.target.checked)} />
        Monitorar Docker e containers
      </label>

      {/* systemd services */}
      <div>
        <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>Serviços systemd monitorados</h3>
        <div className="flex flex-wrap gap-2 mb-2">
          {services.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full" style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
              {s.name}
              <button onClick={() => setServices(services.filter((x) => x.name !== s.name))} style={{ color: "var(--text-muted)" }}>×</button>
            </span>
          ))}
          {services.length === 0 && <span className="text-xs" style={{ color: "var(--text-muted)" }}>nenhum</span>}
        </div>
        <div className="flex gap-2">
          <input
            value={newService}
            onChange={(e) => setNewService(e.target.value)}
            placeholder="ex: nginx"
            className="flex-1 text-sm rounded-lg px-3 py-1.5"
            style={inputStyle}
          />
          <button
            onClick={() => {
              const n = newService.trim();
              if (n && !services.some((s) => s.name === n)) setServices([...services, { type: "systemd", name: n }]);
              setNewService("");
            }}
            className="px-3 py-1.5 text-sm rounded-lg"
            style={{ backgroundColor: "var(--card-elevated)", color: "var(--accent)", border: "1px solid var(--border)" }}
          >
            Adicionar
          </button>
        </div>
      </div>

      {/* Re-enroll token */}
      <div>
        <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Recadastrar token</h3>
        <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Use se reinstalou o agente e ele gerou um token novo.</p>
        <input
          value={newToken}
          onChange={(e) => setNewToken(e.target.value)}
          placeholder="cole o novo token (opcional)"
          className="w-full text-sm rounded-lg px-3 py-1.5 font-mono"
          style={inputStyle}
        />
      </div>

      {msg && <p className="text-sm" style={{ color: msg.includes("salva") ? "var(--success)" : "var(--error)" }}>{msg}</p>}

      <div className="flex items-center justify-between pt-2" style={{ borderTop: "1px solid var(--border)" }}>
        <button onClick={remove} className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)" }}>
          <Trash2 className="w-4 h-4" />
          Remover VPS
        </button>
        <button onClick={save} disabled={saving} className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg" style={{ backgroundColor: "var(--accent)", color: "white", opacity: saving ? 0.7 : 1 }}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Salvar
        </button>
      </div>
    </div>
  );
}

function ThresholdInput({ label, pair, step = 1, onChange }: { label: string; pair: { warning: number; critical: number }; step?: number; onChange: (p: { warning: number; critical: number }) => void }) {
  return (
    <div>
      <label className="block text-[11px] uppercase mb-1" style={{ color: "var(--text-muted)" }}>{label}</label>
      <div className="flex gap-1">
        <input type="number" step={step} value={pair.warning} onChange={(e) => onChange({ ...pair, warning: Number(e.target.value) })} className="w-full text-sm rounded-lg px-2 py-1.5" style={{ ...inputStyle, borderColor: "color-mix(in srgb, var(--warning) 40%, var(--border))" }} title="alerta" />
        <input type="number" step={step} value={pair.critical} onChange={(e) => onChange({ ...pair, critical: Number(e.target.value) })} className="w-full text-sm rounded-lg px-2 py-1.5" style={{ ...inputStyle, borderColor: "color-mix(in srgb, var(--error) 40%, var(--border))" }} title="crítico" />
      </div>
    </div>
  );
}

/* ── Small presentational helpers ──────────────────────────────────── */

function ChartCard({ title, icon: Icon, current, children }: { title: string; icon: React.ComponentType<{ className?: string }>; current: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          <Icon className="w-4 h-4" />
          {title}
        </span>
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{current}</span>
      </div>
      {children}
    </div>
  );
}

function Panel({ title, icon: Icon, right, children }: { title: string; icon: React.ComponentType<{ className?: string }>; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          <Icon className="w-4 h-4" />
          {title}
        </span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}>
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>{children}</p>;
}

const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--card-elevated)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  outline: "none",
};

function fmtPct(v: number | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "var(--error)";
  if (pct >= 75) return "var(--warning)";
  return "var(--success)";
}
