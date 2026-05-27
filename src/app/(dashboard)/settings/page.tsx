"use client";

import { useEffect, useState } from "react";
import { Settings, RefreshCw } from "lucide-react";
import { SystemInfo } from "@/components/SystemInfo";
import { IntegrationStatus } from "@/components/IntegrationStatus";
import { MemoryMcpCard } from "@/components/MemoryMcpCard";
import { QuickActions } from "@/components/QuickActions";
import { RecoveryPanel } from "@/components/RecoveryPanel";
import { UpdatePanel } from "@/components/UpdatePanel";
import { RestorePanel } from "@/components/RestorePanel";
import { ResetOpenClawPanel } from "@/components/setup/ResetOpenClawPanel";

interface SystemData {
  agent: {
    name: string;
    creature: string;
    emoji: string;
  };
  system: {
    uptime: number;
    uptimeFormatted: string;
    nodeVersion: string;
    model: string;
    workspacePath: string;
    platform: string;
    hostname: string;
    memory: {
      total: number;
      free: number;
      used: number;
    };
  };
  integrations: Array<{
    id: string;
    name: string;
    status: "connected" | "disconnected" | "configured" | "not_configured";
    icon: string;
    lastActivity: string | null;
  }>;
  timestamp: string;
}

export default function SettingsPage() {
  const [systemData, setSystemData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchSystemData = async () => {
    try {
      const res = await fetch("/api/system");
      const data = await res.json();
      setSystemData(data);
      setLastRefresh(new Date());
    } catch (error) {
      console.error("Failed to fetch system data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemData();
    const interval = setInterval(fetchSystemData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    setLoading(true);
    fetchSystemData();
  };

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 md:mb-8">
        <div>
          <h1 
            className="text-2xl md:text-3xl font-bold mb-1 md:mb-2 flex items-center gap-2 md:gap-3"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            <Settings className="w-6 h-6 md:w-8 md:h-8" style={{ color: "var(--accent)" }} />
            Configurações
          </h1>
          <p className="text-sm md:text-base" style={{ color: "var(--text-secondary)" }}>
            Status do sistema, integrações e configurações
          </p>
        </div>

        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50 w-full sm:w-auto"
          style={{ 
            backgroundColor: "var(--card)", 
            color: "var(--text-secondary)",
            border: "1px solid var(--border)"
          }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {/* Last Refresh Time */}
      {lastRefresh && (
        <div className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
          Última atualização: {lastRefresh.toLocaleTimeString()}
        </div>
      )}

      {/* Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        {/* Update System */}
        <div className="lg:col-span-2">
          <UpdatePanel />
        </div>

        {/* Restore Backup */}
        <div className="lg:col-span-2">
          <RestorePanel />
        </div>

        {/* System Info - Full width on first row */}
        <div className="lg:col-span-2">
          <SystemInfo data={systemData} />
        </div>

        {/* Recovery Panel - Full width, prominent */}
        <div className="lg:col-span-2">
          <RecoveryPanel />
        </div>

        {/* Memory MCP — agent-curated memory (Hermes-style) */}
        <div className="lg:col-span-2">
          <MemoryMcpCard />
        </div>

        {/* Integration Status */}
        <div>
          <IntegrationStatus integrations={systemData?.integrations || null} />
        </div>

        {/* Quick Actions */}
        <div>
          <QuickActions onActionComplete={handleRefresh} />
        </div>

        {/* Danger zone — destructive reset of the OpenClaw install */}
        <div className="lg:col-span-2">
          <ResetOpenClawPanel />
        </div>
      </div>

      {/* Footer Info */}
      <div 
        className="mt-6 md:mt-8 p-3 md:p-4 rounded-xl"
        style={{ 
          backgroundColor: "rgba(26, 26, 26, 0.5)", 
          border: "1px solid var(--border)" 
        }}
      >
        <div className="flex items-center justify-between text-sm" style={{ color: "var(--text-muted)" }}>
          <span>Mission Control v1.0.0</span>
          <span>OpenClaw Agent Dashboard</span>
        </div>
      </div>
    </div>
  );
}
