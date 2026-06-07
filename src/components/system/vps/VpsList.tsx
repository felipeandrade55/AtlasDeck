"use client";

import { Plus, Server, Cpu, MemoryStick, HardDrive, Boxes, AlertTriangle } from "lucide-react";
import type { VpsHost } from "./types";
import { relativeTime, statusColor, statusLabel } from "./types";

function MiniBar({ label, value, icon: Icon }: { label: string; value: number | undefined; icon: React.ComponentType<{ className?: string }> }) {
  const v = typeof value === "number" ? value : null;
  const color = v == null ? "var(--text-muted)" : v >= 90 ? "var(--error)" : v >= 75 ? "var(--warning)" : "var(--success)";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          <Icon className="w-3 h-3" />
          {label}
        </span>
        <span className="text-[11px] font-semibold" style={{ color }}>
          {v == null ? "—" : `${v.toFixed(0)}%`}
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--card-elevated)" }}>
        <div className="h-full rounded-full" style={{ width: `${v == null ? 0 : Math.min(100, v)}%`, backgroundColor: color, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

export function VpsList({
  hosts,
  loading,
  onSelect,
  onAdd,
}: {
  hosts: VpsHost[];
  loading: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {hosts.length} VPS monitorado{hosts.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={onAdd}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent) 15%, transparent)",
            color: "var(--accent)",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
          }}
        >
          <Plus className="w-4 h-4" />
          Adicionar VPS
        </button>
      </div>

      {loading && hosts.length === 0 ? (
        <div className="flex items-center justify-center py-12" style={{ color: "var(--text-muted)" }}>
          Carregando…
        </div>
      ) : hosts.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)", border: "1px dashed var(--border)" }}>
          <Server className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
          <h3 className="text-base font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
            Nenhum VPS monitorado ainda
          </h3>
          <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
            Adicione um VPS, rode o script no servidor e cole o token gerado.
          </p>
          <button
            onClick={onAdd}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg"
            style={{ backgroundColor: "var(--accent)", color: "white" }}
          >
            <Plus className="w-4 h-4" />
            Adicionar VPS
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {hosts.map((host) => {
            const m = host.last_snapshot?.metrics || {};
            const downServices = (host.last_snapshot?.services || []).filter((s) => !s.active).length;
            const containers = host.last_snapshot?.docker?.containers || [];
            const downContainers = containers.filter((c) => c.state !== "running").length;
            return (
              <button
                key={host.vps_id}
                onClick={() => onSelect(host.vps_id)}
                className="text-left rounded-xl p-4 transition-all hover:opacity-90"
                style={{ backgroundColor: "color-mix(in srgb, var(--card) 60%, transparent)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor(host.status) }} />
                      <h3 className="font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                        {host.name}
                      </h3>
                    </div>
                    <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                      {host.hostname || "—"} · {host.os || "—"}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0 ml-2">
                    <span className="text-[11px] font-medium" style={{ color: statusColor(host.status) }}>
                      {statusLabel(host.status)}
                    </span>
                    <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {relativeTime(host.last_seen_ms)}
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <MiniBar label="CPU" value={m.cpu_usage} icon={Cpu} />
                  <MiniBar label="RAM" value={m.ram_used_pct} icon={MemoryStick} />
                  <MiniBar label="Disco" value={m.disk_used_pct} icon={HardDrive} />
                </div>

                {(downServices > 0 || downContainers > 0 || containers.length > 0) && (
                  <div className="flex items-center gap-3 mt-3 pt-3 text-[11px]" style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
                    {containers.length > 0 && (
                      <span className="flex items-center gap-1">
                        <Boxes className="w-3 h-3" />
                        {containers.length} container{containers.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    {(downServices > 0 || downContainers > 0) && (
                      <span className="flex items-center gap-1" style={{ color: "var(--error)" }}>
                        <AlertTriangle className="w-3 h-3" />
                        {downServices + downContainers} parado{downServices + downContainers !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
