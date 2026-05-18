"use client";

import { MessageCircle, Twitter, Mail, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface Integration {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "configured" | "not_configured";
  icon: string;
  lastActivity: string | null;
}

interface IntegrationStatusProps {
  integrations: Integration[] | null;
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  MessageCircle,
  Twitter,
  Mail,
};

const statusConfig = {
  connected: {
    icon: CheckCircle,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    label: "Conectado",
  },
  disconnected: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    label: "Desconectado",
  },
  configured: {
    icon: CheckCircle,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    label: "Configurado",
  },
  not_configured: {
    icon: AlertCircle,
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    label: "Não Configurado",
  },
};

export function IntegrationStatus({ integrations }: IntegrationStatusProps) {
  if (!integrations) {
    return (
      <div className="rounded-xl p-6 animate-pulse" style={{ backgroundColor: "var(--card)" }}>
        <div className="h-6 rounded w-1/3 mb-4" style={{ backgroundColor: "var(--card-elevated, var(--border))" }}></div>
        <div className="space-y-3">
          <div className="h-16 rounded" style={{ backgroundColor: "var(--card-elevated, var(--border))" }}></div>
          <div className="h-16 rounded" style={{ backgroundColor: "var(--card-elevated, var(--border))" }}></div>
          <div className="h-16 rounded" style={{ backgroundColor: "var(--card-elevated, var(--border))" }}></div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)" }}>
      <h2
        className="text-xl font-semibold mb-6 flex items-center gap-2"
        style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
      >
        <MessageCircle className="w-5 h-5" style={{ color: "var(--accent)" }} />
        Integrações
      </h2>

      <div className="space-y-3">
        {integrations.map((integration) => {
          const Icon = iconMap[integration.icon] || MessageCircle;
          const status = statusConfig[integration.status];
          const StatusIcon = status.icon;

          return (
            <div
              key={integration.id}
              className={`flex items-center justify-between p-4 rounded-lg border ${status.bg} ${status.border}`}
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg" style={{ backgroundColor: "var(--card-elevated, rgba(255,255,255,0.06))" }}>
                  <Icon className="w-5 h-5" style={{ color: "var(--text-secondary)" }} />
                </div>
                <div>
                  <div className="font-medium" style={{ color: "var(--text-primary)" }}>{integration.name}</div>
                  {integration.lastActivity && (
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                      Última atividade:{" "}
                      {formatDistanceToNow(new Date(integration.lastActivity), {
                        addSuffix: true,
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className={`flex items-center gap-2 ${status.color}`}>
                <StatusIcon className="w-4 h-4" />
                <span className="text-sm font-medium">{status.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
