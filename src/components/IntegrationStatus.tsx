"use client";

import { useEffect, useState } from "react";
import {
  MessageCircle,
  Twitter,
  Mail,
  CheckCircle,
  XCircle,
  AlertCircle,
  Settings as SettingsIcon,
  Loader2,
  AlertTriangle,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { TelegramSetupModal } from "./TelegramSetupModal";
import { TelegramDoctor } from "./TelegramDoctor";

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

const iconMap: Record<string, LucideIcon> = {
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

interface TelegramQuickStatus {
  loading: boolean;
  enabled: boolean;
  accounts: Array<{
    id: string;
    botUsername: string | null;
    chatId: string | null;
    botOk: boolean;
    webhookUrl: string | null;
    pendingUpdates: number;
    webhookLastError: string | null;
  }>;
  healthy: boolean;
  issueCount: number;
  error: string | null;
}

export function IntegrationStatus({ integrations }: IntegrationStatusProps) {
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [tg, setTg] = useState<TelegramQuickStatus>({
    loading: true,
    enabled: false,
    accounts: [],
    healthy: false,
    issueCount: 0,
    error: null,
  });

  const fetchTelegram = async () => {
    try {
      const res = await fetch("/api/integrations/telegram?live=1", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTg({
        loading: false,
        enabled: !!json.config?.enabled,
        accounts: (json.accounts || []).map((a: {
          id: string;
          diagnostics?: {
            bot?: { ok?: boolean; result?: { username?: string } };
            webhook?: { result?: { url?: string; pending_update_count?: number; last_error_message?: string } };
          };
          chatId?: string | null;
        }) => ({
          id: a.id,
          botUsername: a.diagnostics?.bot?.result?.username ?? null,
          chatId: a.chatId ?? null,
          botOk: !!a.diagnostics?.bot?.ok,
          webhookUrl: a.diagnostics?.webhook?.result?.url || null,
          pendingUpdates: a.diagnostics?.webhook?.result?.pending_update_count ?? 0,
          webhookLastError: a.diagnostics?.webhook?.result?.last_error_message ?? null,
        })),
        healthy: !!json.summary?.healthy,
        issueCount: (json.summary?.issues || []).length,
        error: null,
      });
    } catch (e) {
      setTg((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  useEffect(() => {
    fetchTelegram();
    // refresh quick status whenever the modal closes (changes might have been saved)
  }, []);

  // Deep-link from bell notification: /settings?openDoctor=1 opens the
  // doctor automatically and then strips the param so a refresh doesn't
  // re-trigger it. Uses window.location to avoid Suspense boundary issues
  // with useSearchParams in nested client components.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("openDoctor") === "1") {
      setDoctorOpen(true);
      params.delete("openDoctor");
      const search = params.toString();
      const newUrl = window.location.pathname + (search ? `?${search}` : "");
      window.history.replaceState({}, "", newUrl);
    }
  }, []);

  useEffect(() => {
    if (!telegramOpen) {
      // refresh after closing to reflect saved edits
      fetchTelegram();
    }
  }, [telegramOpen]);

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
    <>
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
            const isTelegram = integration.id === "telegram";

            return (
              <div
                key={integration.id}
                className={`rounded-lg border ${status.bg} ${status.border}`}
              >
                <div className="flex items-center justify-between p-4">
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
                            locale: ptBR,
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className={`flex items-center gap-2 ${status.color}`}>
                      <StatusIcon className="w-4 h-4" />
                      <span className="text-sm font-medium">{status.label}</span>
                    </div>
                    {isTelegram && (
                      <>
                        <button
                          onClick={() => setDoctorOpen(true)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                          style={{
                            backgroundColor: tg.healthy
                              ? "rgba(16,185,129,0.12)"
                              : "rgba(250,204,21,0.15)",
                            color: tg.healthy ? "#86efac" : "#fde047",
                            border: `1px solid ${tg.healthy ? "rgba(16,185,129,0.35)" : "rgba(250,204,21,0.35)"}`,
                          }}
                          title="Rodar diagnóstico completo + mandar teste"
                        >
                          <Stethoscope className="w-3 h-3" />
                          Diagnosticar
                        </button>
                        <button
                          onClick={() => setTelegramOpen(true)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                          style={{
                            backgroundColor: "rgba(139,92,246,0.15)",
                            color: "#c4b5fd",
                            border: "1px solid rgba(139,92,246,0.35)",
                          }}
                          title="Abrir configuração"
                        >
                          <SettingsIcon className="w-3 h-3" />
                          Setup
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Telegram detail row */}
                {isTelegram && (
                  <div className="px-4 pb-3 text-xs space-y-1" style={{ color: "var(--text-secondary)" }}>
                    {tg.loading && (
                      <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Coletando detalhes do Telegram…
                      </div>
                    )}
                    {!tg.loading && tg.error && (
                      <div className="flex items-center gap-1.5" style={{ color: "#fca5a5" }}>
                        <XCircle className="w-3 h-3" />
                        {tg.error}
                      </div>
                    )}
                    {!tg.loading && !tg.error && (
                      <>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>
                            Canal:{" "}
                            <strong style={{ color: tg.enabled ? "#34d399" : "#facc15" }}>
                              {tg.enabled ? "habilitado" : "desabilitado"}
                            </strong>
                          </span>
                          <span>
                            Saúde:{" "}
                            <strong style={{ color: tg.healthy ? "#34d399" : "#facc15" }}>
                              {tg.healthy ? "ok" : `${tg.issueCount} alerta(s)`}
                            </strong>
                          </span>
                          <span>
                            Contas:{" "}
                            <strong style={{ color: "var(--text-primary)" }}>{tg.accounts.length}</strong>
                          </span>
                        </div>
                        {tg.accounts.length === 0 && (
                          <div style={{ color: "var(--text-muted)" }}>
                            Nenhum bot configurado em <code>channels.telegram.accounts</code>.
                          </div>
                        )}
                        {tg.accounts.map((a) => (
                          <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span className="font-mono" style={{ color: "var(--text-primary)" }}>{a.id}</span>
                            <span>
                              bot:{" "}
                              {a.botOk ? (
                                <strong style={{ color: "#34d399" }}>@{a.botUsername || "?"}</strong>
                              ) : (
                                <strong style={{ color: "#fca5a5" }}>inválido</strong>
                              )}
                            </span>
                            <span>
                              chat: <span style={{ color: a.chatId ? "var(--text-primary)" : "#facc15" }}>{a.chatId || "não definido"}</span>
                            </span>
                            {a.webhookUrl && (
                              <span style={{ color: "#facc15" }} title={a.webhookUrl}>
                                <AlertTriangle className="w-3 h-3 inline-block mr-0.5" />
                                webhook ativo
                              </span>
                            )}
                            {a.pendingUpdates > 0 && (
                              <span style={{ color: "#facc15" }}>{a.pendingUpdates} pendentes</span>
                            )}
                            {a.webhookLastError && (
                              <span style={{ color: "#fca5a5" }} title={a.webhookLastError}>
                                erro no webhook
                              </span>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <TelegramSetupModal open={telegramOpen} onClose={() => setTelegramOpen(false)} />
      <TelegramDoctor
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        onChanged={fetchTelegram}
      />
    </>
  );
}
