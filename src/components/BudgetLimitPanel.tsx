"use client";

import { useState, useEffect } from "react";
import {
  Shield,
  ShieldAlert,
  AlertTriangle,
  Lock,
  Unlock,
  Send,
  Info,
  DollarSign,
  Save,
  HelpCircle,
  Bell,
  CheckCircle2
} from "lucide-react";

interface CostSettingsExtended {
  budget: number;
  alertThreshold: number;
  limitTimeframe: "daily" | "weekly" | "monthly";
  limitUsd: number;
  behaviorMode: "alert_only" | "alert_and_lock";
  telegramBotToken: string;
  telegramChatId: string;
  isLocked: boolean;
  timeframeCost: number;
}

interface BudgetLimitPanelProps {
  initialSettings: CostSettingsExtended;
  onSaveSuccess: () => void;
}

export function BudgetLimitPanel({ initialSettings, onSaveSuccess }: BudgetLimitPanelProps) {
  const [timeframe, setTimeframe] = useState<"daily" | "weekly" | "monthly">(initialSettings.limitTimeframe || "monthly");
  const [limitUsd, setLimitUsd] = useState(String(initialSettings.limitUsd || initialSettings.budget || "100"));
  const [alertThreshold, setAlertThreshold] = useState(String(initialSettings.alertThreshold || "80"));
  const [behaviorMode, setBehaviorMode] = useState<"alert_only" | "alert_and_lock">(initialSettings.behaviorMode || "alert_only");
  const [botToken, setBotToken] = useState(initialSettings.telegramBotToken || "");
  const [chatId, setChatId] = useState(initialSettings.telegramChatId || "");
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);

  // Auto-detect dirty state
  const isDirty =
    timeframe !== initialSettings.limitTimeframe ||
    limitUsd !== String(initialSettings.limitUsd) ||
    alertThreshold !== String(initialSettings.alertThreshold) ||
    behaviorMode !== initialSettings.behaviorMode ||
    botToken !== (initialSettings.telegramBotToken || "") ||
    chatId !== (initialSettings.telegramChatId || "");

  useEffect(() => {
    if (initialSettings.telegramBotToken || initialSettings.telegramChatId) {
      setShowTelegram(true);
    }
  }, [initialSettings]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const budgetNum = Number(limitUsd);
      const thresholdNum = Number(alertThreshold);

      if (isNaN(budgetNum) || budgetNum <= 0) {
        throw new Error("O limite de custos deve ser um valor numérico positivo.");
      }
      if (isNaN(thresholdNum) || thresholdNum <= 0 || thresholdNum > 100) {
        throw new Error("O percentual de alerta deve ser um valor entre 1% e 100%.");
      }

      const res = await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limitTimeframe: timeframe,
          limitUsd: budgetNum,
          alertThreshold: thresholdNum,
          behaviorMode,
          telegramBotToken: botToken,
          telegramChatId: chatId,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.detail || data?.error || "Falha ao salvar configurações.");
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      onSaveSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  const limitNum = Number(limitUsd) || 100;
  const currentCost = initialSettings.timeframeCost || 0;
  const progressPercent = limitNum > 0 ? (currentCost / limitNum) * 100 : 0;
  const warningPercent = Number(alertThreshold) || 80;

  // Compute status colors & descriptions
  let statusColor = "var(--success)";
  let statusText = "Normal";
  let statusDesc = "Consumo dentro da margem de segurança configurada.";
  let StatusIcon = CheckCircle2;
  let statusGlow = "rgba(52, 199, 89, 0.15)";

  if (currentCost >= limitNum) {
    statusColor = "var(--error)";
    statusText = initialSettings.behaviorMode === "alert_and_lock" ? "Bloqueado" : "Excedido";
    statusDesc = initialSettings.behaviorMode === "alert_and_lock"
      ? "Limite excedido! A trava de segurança está ativada e bloqueou comandos do OpenClaw."
      : "Limite de custos geral foi excedido! Alertas foram disparados.";
    StatusIcon = initialSettings.behaviorMode === "alert_and_lock" ? Lock : ShieldAlert;
    statusGlow = "rgba(255, 59, 48, 0.2)";
  } else if (progressPercent >= warningPercent) {
    statusColor = "var(--warning)";
    statusText = "Aviso";
    statusDesc = "Consumo próximo do limite geral configurado. Alerta preventivo ativo.";
    StatusIcon = AlertTriangle;
    statusGlow = "rgba(255, 149, 0, 0.15)";
  }

  const timeframeLabels = {
    daily: "diário",
    weekly: "semanal",
    monthly: "mensal",
  };

  return (
    <div
      className="p-6 rounded-xl relative overflow-hidden transition-all duration-300"
      style={{
        backgroundColor: "var(--card)",
        border: `1px solid var(--border)`,
        boxShadow: `0 8px 32px 0 ${statusGlow}`,
      }}
    >
      {/* Premium Background Ambient Glow */}
      <div
        className="absolute top-0 right-0 w-64 h-64 rounded-full pointer-events-none filter blur-[80px]"
        style={{
          background: `radial-gradient(circle, ${statusColor} 0%, transparent 70%)`,
          opacity: 0.1,
        }}
      />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between relative z-10">
        
        {/* Left Side: General Info & Status Indicator */}
        <div className="flex-1 space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="p-2.5 rounded-lg flex items-center justify-center transition-all duration-500"
              style={{
                backgroundColor: "var(--card-elevated)",
                border: `1px solid ${statusColor}`,
                boxShadow: `0 0 12px ${statusColor}`,
              }}
            >
              <StatusIcon className="w-6 h-6 animate-pulse" style={{ color: statusColor }} />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                Meta de Custo & Trava de Segurança
              </h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Monitore o teto de gastos gerais e defina travas contra surtos de API.
              </p>
            </div>
          </div>

          {/* Current Spent Progress */}
          <div className="space-y-2 p-4 rounded-lg" style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
                Consumo {timeframeLabels[timeframe]} atual:
              </span>
              <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                ${currentCost.toFixed(2)} / ${limitNum.toFixed(2)} ({progressPercent.toFixed(1)}%)
              </span>
            </div>
            
            <div className="h-3 rounded-full overflow-hidden relative" style={{ backgroundColor: "rgba(255, 255, 255, 0.05)" }}>
              {/* Progress fill */}
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(progressPercent, 100)}%`,
                  background: `linear-gradient(90deg, var(--accent) 0%, ${statusColor} 100%)`,
                }}
              />
              {/* Warning marker */}
              <div
                className="absolute top-0 bottom-0 w-0.5"
                style={{
                  left: `${warningPercent}%`,
                  backgroundColor: "rgba(255, 255, 255, 0.2)",
                }}
                title={`Limite de aviso: ${warningPercent}%`}
              />
            </div>

            <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span>0%</span>
              <span>Aviso ({warningPercent}%)</span>
              <span>Limite (100%)</span>
            </div>
          </div>

          <div
            className="flex items-start gap-2.5 p-3.5 rounded-lg text-xs"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.02)",
              borderLeft: `3px solid ${statusColor}`,
            }}
          >
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: statusColor }} />
            <div>
              <span className="font-semibold" style={{ color: "var(--text-primary)" }}>Status: {statusText}</span>
              <p className="mt-0.5" style={{ color: "var(--text-secondary)" }}>{statusDesc}</p>
            </div>
          </div>
        </div>

        {/* Right Side: Interactive Configuration Forms */}
        <div className="flex-1 w-full lg:max-w-md space-y-4">
          <div className="grid grid-cols-2 gap-4">
            
            {/* Limit Timeframe Select */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Período da Meta
              </label>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as any)}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none cursor-pointer transition-all"
                style={{
                  backgroundColor: "var(--card-elevated)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="daily">Diário</option>
                <option value="weekly">Semanal</option>
                <option value="monthly">Mensal</option>
              </select>
            </div>

            {/* Limit Amount Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Custo Limite (USD)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted" style={{ color: "var(--text-muted)" }}>$</span>
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  value={limitUsd}
                  onChange={(e) => setLimitUsd(e.target.value)}
                  className="w-full rounded-lg pl-6 pr-3 py-2 text-sm outline-none transition-all"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                  placeholder="0.00"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Warning Alarm Threshold Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Disparar aviso em (%)
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={alertThreshold}
                  onChange={(e) => setAlertThreshold(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                  placeholder="80"
                />
                <span className="absolute right-3 top-2.5 text-xs text-muted" style={{ color: "var(--text-muted)" }}>%</span>
              </div>
            </div>

            {/* Behavior Mode Toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Ao atingir o limite
              </label>
              <select
                value={behaviorMode}
                onChange={(e) => setBehaviorMode(e.target.value as any)}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none cursor-pointer transition-all"
                style={{
                  backgroundColor: "var(--card-elevated)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="alert_only">Apenas Alerta</option>
                <option value="alert_and_lock">Alerta & Trava</option>
              </select>
            </div>
          </div>

          {/* Telegram Settings Section */}
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setShowTelegram(!showTelegram)}
              className="w-full px-4 py-2.5 text-xs font-semibold flex items-center justify-between transition-all"
              style={{
                backgroundColor: "var(--card-elevated)",
                color: "var(--text-primary)",
              }}
            >
              <div className="flex items-center gap-2">
                <Send className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                <span>Notificações via Telegram</span>
              </div>
              <span className="text-[10px] uppercase font-bold" style={{ color: "var(--text-muted)" }}>
                {showTelegram ? "Recolher" : "Configurar"}
              </span>
            </button>

            {showTelegram && (
              <div className="p-4 space-y-3" style={{ backgroundColor: "rgba(255, 255, 255, 0.01)", borderTop: "1px solid var(--border)" }}>
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  Insira as credenciais do Telegram para receber resumos. Deixe em branco para usar o padrão configurado em <code>openclaw.json</code>.
                </p>
                <div className="space-y-2">
                  <div>
                    <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
                      Token do Bot
                    </label>
                    <input
                      type="password"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      className="mt-1 w-full rounded-lg px-3 py-1.5 text-xs outline-none transition-all"
                      style={{
                        backgroundColor: "var(--card-elevated)",
                        border: "1px solid var(--border)",
                        color: "var(--text-primary)",
                      }}
                      placeholder={initialSettings.telegramBotToken ? "•••••••••••• (Configurado)" : "Ex: 123456:ABC-def..."}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
                      Chat ID
                    </label>
                    <input
                      type="text"
                      value={chatId}
                      onChange={(e) => setChatId(e.target.value)}
                      className="mt-1 w-full rounded-lg px-3 py-1.5 text-xs outline-none transition-all"
                      style={{
                        backgroundColor: "var(--card-elevated)",
                        border: "1px solid var(--border)",
                        color: "var(--text-primary)",
                      }}
                      placeholder="Ex: -100123456789"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons & Feedback */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="flex-1">
              {error && (
                <p className="text-xs font-medium" style={{ color: "var(--error)" }}>
                  ⚠️ {error}
                </p>
              )}
              {success && (
                <p className="text-xs font-medium" style={{ color: "var(--success)" }}>
                  ✓ Configurações salvas com sucesso!
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all disabled:opacity-40"
              style={{
                backgroundColor: "var(--accent)",
                color: "white",
                cursor: isDirty ? "pointer" : "not-allowed",
              }}
            >
              <Save className="w-4 h-4" />
              {saving ? "Salvando..." : "Salvar Meta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
