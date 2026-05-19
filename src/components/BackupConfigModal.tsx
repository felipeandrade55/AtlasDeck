"use client";

import { useState, useEffect } from "react";
import {
  X,
  Shield,
  Clock,
  CalendarClock,
  Trash2,
  HardDrive,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronRight,
  FolderOpen,
  FileArchive,
} from "lucide-react";

interface BackupConfig {
  enabled: boolean;
  schedule: string;
  retentionDays: number;
  destination: string;
  includeEnv: boolean;
}

interface BackupConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  schedule: "04:00",
  retentionDays: 5,
  destination: "./data/backups",
  includeEnv: true,
};

export function BackupConfigModal({
  isOpen,
  onClose,
  onSaved,
}: BackupConfigModalProps) {
  const [config, setConfig] = useState<BackupConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [saveResult, setSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Load current config
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setSaveResult(null);
    setStep(0);
    fetch("/api/backup/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setConfig({ ...DEFAULT_CONFIG, ...data.config });
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/backup/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: config.enabled,
          schedule: config.schedule,
          retentionDays: config.retentionDays,
          destination: config.destination,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.cronMessage || "Failed to save");
      }
      setSaveResult({
        success: true,
        message:
          data.cronMessage ||
          (config.enabled
            ? `Backup agendado para ${config.schedule}`
            : "Backup automático desativado"),
      });
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const nextStep = () => setStep((s) => Math.min(s + 1, 3));
  const prevStep = () => setStep((s) => Math.max(s - 1, 0));

  const includedItems = [
    { label: "Configuração OpenClaw (openclaw.json)", icon: "🔐" },
    { label: "Sessões dos agentes (transcrições)", icon: "📝" },
    { label: "Workspaces e memórias", icon: "🧠" },
    { label: "Mídia e arquivos", icon: "🖼️" },
    { label: "Banco de dados do Dashboard", icon: "🗄️" },
    { label: "Skills e plugins", icon: "🧩" },
    { label: ".env (se existir)", icon: "🔑" },
  ];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl shadow-2xl mx-4"
        style={{
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between"
          style={{
            backgroundColor: "var(--card)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2
              className="text-lg font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Configurar Backup
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors"
            style={{
              color: "var(--text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--accent)" }} />
            <span style={{ color: "var(--text-secondary)" }}>Carregando configuração...</span>
          </div>
        ) : saveResult ? (
          <div className="p-8 text-center">
            <CheckCircle2
              className="w-12 h-12 mx-auto mb-4"
              style={{ color: "var(--success)" }}
            />
            <h3
              className="text-lg font-semibold mb-2"
              style={{ color: "var(--text-primary)" }}
            >
              Configuração salva!
            </h3>
            <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
              {saveResult.message}
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-semibold"
              style={{
                backgroundColor: "var(--accent)",
                color: "#000",
                border: "none",
                cursor: "pointer",
              }}
            >
              Fechar
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Error */}
            {error && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg text-sm"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--error) 10%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
                  color: "var(--error)",
                }}
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-4">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    flex: 1,
                    backgroundColor:
                      i <= step
                        ? "var(--accent)"
                        : "color-mix(in srgb, var(--border) 50%, transparent)",
                  }}
                />
              ))}
            </div>

            {/* Step 0 — Activation */}
            {step === 0 && (
              <div className="space-y-4">
                <div className="text-center py-4">
                  <Shield
                    className="w-12 h-12 mx-auto mb-3"
                    style={{ color: "var(--accent)" }}
                  />
                  <h3
                    className="text-base font-semibold mb-1"
                    style={{ color: "var(--text-primary)" }}
                  >
                    Backup Automático
                  </h3>
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Proteja seus dados do OpenClaw e Dashboard com backups
                    compactados e versionados.
                  </p>
                </div>

                <div
                  className="flex items-center justify-between p-4 rounded-xl"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div>
                    <p
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      Ativar backup automático
                    </p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      Agenda execução diária no sistema
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setConfig((c) => ({ ...c, enabled: !c.enabled }))
                    }
                    className="relative w-11 h-6 rounded-full transition-colors"
                    style={{
                      backgroundColor: config.enabled
                        ? "var(--success)"
                        : "var(--border)",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                      style={{
                        transform: config.enabled
                          ? "translateX(20px)"
                          : "translateX(0)",
                      }}
                    />
                  </button>
                </div>
              </div>
            )}

            {/* Step 1 — Schedule */}
            {step === 1 && (
              <div className="space-y-4">
                <h3
                  className="text-base font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  Horário do Backup
                </h3>

                <div
                  className="flex items-center gap-3 p-4 rounded-xl"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <CalendarClock
                    className="w-5 h-5 flex-shrink-0"
                    style={{ color: "var(--accent)" }}
                  />
                  <div className="flex-1">
                    <label
                      className="block text-xs font-medium mb-1"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      Executar todos os dias às
                    </label>
                    <input
                      type="time"
                      value={config.schedule}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, schedule: e.target.value }))
                      }
                      className="w-full text-sm"
                      style={{
                        padding: "0.5rem 0.75rem",
                        backgroundColor: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: "0.5rem",
                        color: "var(--text-primary)",
                        outline: "none",
                      }}
                    />
                  </div>
                </div>

                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Recomendamos um horário de baixa atividade (ex: 04:00) para
                  evitar impacto no desempenho.
                </p>
              </div>
            )}

            {/* Step 2 — Retention */}
            {step === 2 && (
              <div className="space-y-4">
                <h3
                  className="text-base font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  Política de Retenção
                </h3>

                <div
                  className="p-4 rounded-xl space-y-3"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4" style={{ color: "var(--warning)" }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        Manter backups por
                      </span>
                    </div>
                    <span
                      className="text-sm font-bold"
                      style={{ color: "var(--accent)" }}
                    >
                      {config.retentionDays} dias
                    </span>
                  </div>

                  <input
                    type="range"
                    min={1}
                    max={30}
                    value={config.retentionDays}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        retentionDays: parseInt(e.target.value),
                      }))
                    }
                    className="w-full"
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div className="flex justify-between text-xs" style={{ color: "var(--text-muted)" }}>
                    <span>1 dia</span>
                    <span>15 dias</span>
                    <span>30 dias</span>
                  </div>
                </div>

                <div
                  className="p-4 rounded-xl"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <FolderOpen className="w-4 h-4" style={{ color: "var(--info)" }} />
                    <span
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      Diretório de destino
                    </span>
                  </div>
                  <input
                    type="text"
                    value={config.destination}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, destination: e.target.value }))
                    }
                    className="w-full text-sm"
                    style={{
                      padding: "0.5rem 0.75rem",
                      backgroundColor: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: "0.5rem",
                      color: "var(--text-primary)",
                      outline: "none",
                    }}
                  />
                </div>
              </div>
            )}

            {/* Step 3 — Summary */}
            {step === 3 && (
              <div className="space-y-4">
                <h3
                  className="text-base font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  Resumo da Configuração
                </h3>

                <div
                  className="p-4 rounded-xl space-y-2"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: "var(--text-muted)" }}>Status</span>
                    <span
                      className="font-medium"
                      style={{
                        color: config.enabled
                          ? "var(--success)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {config.enabled ? "Ativo" : "Desativado"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: "var(--text-muted)" }}>Horário</span>
                    <span
                      className="font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      Todos os dias às {config.schedule}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: "var(--text-muted)" }}>Retenção</span>
                    <span
                      className="font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {config.retentionDays} dias
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: "var(--text-muted)" }}>Destino</span>
                    <span
                      className="font-medium truncate max-w-[200px]"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {config.destination}
                    </span>
                  </div>
                </div>

                <div
                  className="p-4 rounded-xl"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <p
                    className="text-sm font-medium mb-2"
                    style={{ color: "var(--text-primary)" }}
                  >
                    O que será incluído no backup
                  </p>
                  <div className="space-y-1.5">
                    {includedItems.map((item) => (
                      <div
                        key={item.label}
                        className="flex items-center gap-2 text-xs"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <span>{item.icon}</span>
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div
              className="flex items-center justify-between pt-4"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              {step > 0 ? (
                <button
                  onClick={prevStep}
                  className="px-4 py-2 text-sm rounded-lg"
                  style={{
                    color: "var(--text-secondary)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Voltar
                </button>
              ) : (
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm rounded-lg"
                  style={{
                    color: "var(--text-muted)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Cancelar
                </button>
              )}

              {step < 3 ? (
                <button
                  onClick={nextStep}
                  className="flex items-center gap-1 px-4 py-2 text-sm font-semibold rounded-lg"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "#000",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Próximo
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "#000",
                    border: "none",
                    cursor: saving ? "not-allowed" : "pointer",
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      Concluir
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
