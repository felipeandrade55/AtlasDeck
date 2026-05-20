"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, HardDrive, MemoryStick, Shield, ShieldCheck, Clock } from "lucide-react";

interface SystemStats {
  cpu: number;
  ram: { used: number; total: number };
  disk: { used: number; total: number };
  vpnActive: boolean;
  firewallActive: boolean;
  activeServices: number;
  totalServices: number;
  uptime: string;
}

export function StatusBar() {
  const [stats, setStats] = useState<SystemStats>({
    cpu: 0,
    ram: { used: 0, total: 4 },
    disk: { used: 0, total: 100 },
    vpnActive: false,
    firewallActive: true,
    activeServices: 0,
    totalServices: 4,
    uptime: "0d 0h",
  });

  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean, sha: string }>({ hasUpdate: false, sha: "..." });
  const router = useRouter();

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/system/stats");
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } catch (error) {
        console.error("Failed to fetch system stats:", error);
      }
    };

    const fetchUpdateCheck = async () => {
      try {
        const res = await fetch("/api/update/check");
        if (res.ok) {
          const data = await res.json();
          setUpdateInfo({ hasUpdate: data.hasUpdate, sha: data.localSha?.slice(0, 7) || "..." });
        }
      } catch (error) {}
    };

    fetchStats();
    fetchUpdateCheck();
    const interval = setInterval(fetchStats, 10000); // Update every 10s
    const updateInterval = setInterval(fetchUpdateCheck, 5 * 60 * 1000); // Check update every 5m

    return () => {
      clearInterval(interval);
      clearInterval(updateInterval);
    };
  }, []);

  const cpuColor = stats.cpu < 60 ? "var(--positive)" : stats.cpu < 85 ? "var(--warning)" : "var(--negative)";
  const ramPercent = (stats.ram.used / stats.ram.total) * 100;
  const ramColor = ramPercent < 60 ? "var(--positive)" : ramPercent < 85 ? "var(--warning)" : "var(--negative)";
  const diskPercent = (stats.disk.used / stats.disk.total) * 100;
  const diskColor = diskPercent < 60 ? "var(--positive)" : diskPercent < 85 ? "var(--warning)" : "var(--negative)";

  // StatusMetric component
  const StatusMetric = ({ icon: Icon, label, value, barPercent, color }: any) => (
    <div className="flex items-center gap-1.5" style={{ height: "24px" }}>
      <Icon style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "1px",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-secondary)",
        }}
      >
        {value}
      </span>
      {barPercent !== undefined && (
        <div
          style={{
            width: "48px",
            height: "4px",
            backgroundColor: "var(--surface-elevated)",
            borderRadius: "2px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, barPercent)}%`,
              height: "100%",
              backgroundColor: color,
              borderRadius: "2px",
            }}
          />
        </div>
      )}
    </div>
  );

  return (
    <div
      className="status-bar"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: "32px",
        backgroundColor: "var(--surface)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px 0 84px",
        gap: "16px",
        zIndex: 40,
      }}
    >
      {/* CPU */}
      <StatusMetric icon={Cpu} label="CPU" value={`${stats.cpu}%`} barPercent={stats.cpu} color={cpuColor} />

      {/* RAM */}
      <StatusMetric
        icon={MemoryStick}
        label="RAM"
        value={`${stats.ram.used.toFixed(1)}/${stats.ram.total}GB`}
        barPercent={ramPercent}
        color={ramColor}
      />

      {/* Disk */}
      <StatusMetric
        icon={HardDrive}
        label="DISK"
        value={`${diskPercent.toFixed(0)}%`}
        barPercent={diskPercent}
        color={diskColor}
      />

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* VPN Status */}
      <div className="flex items-center gap-1">
        <div
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: stats.vpnActive ? "var(--positive)" : "var(--negative)",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "1px",
            color: "var(--text-muted)",
          }}
        >
          VPN
        </span>
      </div>

      {/* Firewall Status */}
      <div className="flex items-center gap-1">
        <ShieldCheck
          style={{
            width: "12px",
            height: "12px",
            color: stats.firewallActive ? "var(--positive)" : "var(--negative)",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "1px",
            color: "var(--text-muted)",
          }}
        >
          UFW
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Systemd Services */}
      <div className="flex items-center gap-1">
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 500,
            color: "var(--text-muted)",
          }}
        >
          SVC: {stats.activeServices}/{stats.totalServices}
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Uptime */}
      <div className="flex items-center gap-1">
        <Clock style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 500,
            color: "var(--text-muted)",
          }}
        >
          Ativo: {stats.uptime}
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Update Indicator */}
      {updateInfo.hasUpdate ? (
        <div 
          className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity" 
          style={{ animation: "pulse 2s infinite" }} 
          onClick={() => router.push('/settings')}
        >
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--warning)" }} />
          <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 600, color: "var(--warning)", letterSpacing: "0.5px" }}>
            UPDATE
          </span>
        </div>
      ) : (
        <div 
          className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity" 
          onClick={() => router.push('/settings')}
        >
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--positive)" }} />
          <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 500, color: "var(--text-muted)" }}>
            v{updateInfo.sha}
          </span>
        </div>
      )}
    </div>
  );
}
