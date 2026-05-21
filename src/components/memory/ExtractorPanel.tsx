"use client";

/**
 * UI for choosing how memories get extracted from sessions.
 *
 * Three options:
 *   - OpenClaw CLI (paid cloud models, default)
 *   - Ollama local (free, requires Ollama installed)
 *   - Heuristic (rule-based fallback, zero LLM)
 *
 * When the user picks Ollama, the panel detects whether Ollama is
 * installed/running, lists local + recommended models, and offers
 * install + pull buttons.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Cpu,
  Download,
  Loader2,
  Pause,
  Play,
  PowerOff,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useToast } from "@/components/Toast";

export type ExtractorProvider = "openclaw" | "ollama" | "heuristic";

interface RecommendedModel {
  name: string;
  label: string;
  family: string;
  paramSize: string;
  diskGB: number;
  ramGB: number;
  quality: "great" | "good" | "fair";
  notes: string;
}

interface OllamaModel {
  name: string;
  size: number;
}

interface OllamaStatusPayload {
  installed: boolean;
  running: boolean;
  version: string | null;
  baseUrl: string;
  models: OllamaModel[];
  platform: string;
  installHint: string;
  recommended: RecommendedModel[];
  service: {
    supported: boolean;
    active: boolean;
    enabled: boolean;
  };
}

type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";

interface PullState {
  id: string;
  model: string;
  status: "running" | "ok" | "fail";
  percent: number;
  message: string;
  error: string | null;
}

interface InstallState {
  id: string;
  status: "running" | "ok" | "fail";
  logs: string;
  error: string | null;
}

interface SettingsState {
  extractor_provider: ExtractorProvider;
  ollama_model: string;
}

interface Props {
  provider: ExtractorProvider;
  ollamaModel: string;
  onSettingsChange: (patch: Partial<SettingsState>) => Promise<void>;
}

const QUALITY_LABEL: Record<RecommendedModel["quality"], string> = {
  great: "ótima",
  good: "boa",
  fair: "razoável",
};

const QUALITY_COLOR: Record<RecommendedModel["quality"], string> = {
  great: "#32D74B",
  good: "#0A84FF",
  fair: "#FFD60A",
};

export function ExtractorPanel({ provider, ollamaModel, onSettingsChange }: Props) {
  const toast = useToast();
  const [ollama, setOllama] = useState<OllamaStatusPayload | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [install, setInstall] = useState<InstallState | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [serviceAction, setServiceAction] = useState<ServiceAction | null>(null);
  const pollers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const refreshStatus = useCallback(async () => {
    try {
      setLoadingStatus(true);
      const res = await fetch("/api/memory/ollama/status");
      if (!res.ok) throw new Error("Falha ao consultar Ollama");
      const data = (await res.json()) as OllamaStatusPayload;
      setOllama(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (provider === "ollama") {
      void refreshStatus();
    }
  }, [provider, refreshStatus]);

  useEffect(() => {
    return () => {
      for (const interval of Object.values(pollers.current)) clearInterval(interval);
    };
  }, []);

  const startInstall = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/ollama/install", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.hint || data?.error || "Auto-install não suportado neste SO");
        return;
      }
      const id = data.id as string;
      setInstall({ id, status: "running", logs: "", error: null });

      const poll = setInterval(async () => {
        try {
          const sres = await fetch(`/api/memory/ollama/install?id=${id}`);
          if (!sres.ok) return;
          const sdata = await sres.json();
          setInstall({
            id,
            status: sdata.status,
            logs: sdata.logs || "",
            error: sdata.error,
          });
          if (sdata.status !== "running") {
            clearInterval(poll);
            if (sdata.status === "ok") {
              toast.success("Ollama instalado");
              refreshStatus();
            } else {
              toast.error(`Instalação falhou: ${sdata.error || "(sem detalhe)"}`);
            }
          }
        } catch {
          // transient — retry on next tick
        }
      }, 2_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  }, [refreshStatus, toast]);

  const startPull = useCallback(
    async (modelName: string) => {
      try {
        const res = await fetch("/api/memory/ollama/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data?.error || "Falha");
          return;
        }
        const id = data.id as string;
        setPulls((prev) => ({
          ...prev,
          [modelName]: { id, model: modelName, status: "running", percent: 0, message: "iniciando", error: null },
        }));

        const interval = setInterval(async () => {
          try {
            const sres = await fetch(`/api/memory/ollama/pull?id=${id}`);
            if (!sres.ok) return;
            const sdata = (await sres.json()) as PullState;
            setPulls((prev) => ({ ...prev, [modelName]: sdata }));
            if (sdata.status !== "running") {
              clearInterval(interval);
              delete pollers.current[modelName];
              if (sdata.status === "ok") {
                toast.success(`${modelName} baixado`);
                refreshStatus();
              } else {
                toast.error(`Falha ao baixar ${modelName}: ${sdata.error || "(sem detalhe)"}`);
              }
            }
          } catch {
            // transient
          }
        }, 1_500);
        pollers.current[modelName] = interval;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha");
      }
    },
    [refreshStatus, toast],
  );

  const runServiceAction = useCallback(
    async (action: ServiceAction) => {
      // Hard-to-reverse confirmation: stopping the daemon kills the
      // extractor mid-run. Quick guard so it's intentional.
      if (action === "stop" && provider === "ollama") {
        if (
          !window.confirm(
            "Parar o Ollama vai cortar a extração de memória até você iniciar de novo. Continuar?",
          )
        ) {
          return;
        }
      }
      try {
        setServiceAction(action);
        const res = await fetch("/api/memory/ollama/service", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          toast.error(data.message || data.error || "Falha no systemctl");
        } else {
          const verb: Record<ServiceAction, string> = {
            start: "iniciado",
            stop: "parado",
            restart: "reiniciado",
            enable: "habilitado no boot",
            disable: "desabilitado do boot",
          };
          toast.success(`Ollama ${verb[action]}`);
        }
        await refreshStatus();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha");
      } finally {
        setServiceAction(null);
      }
    },
    [provider, refreshStatus, toast],
  );

  const localModelNames = new Set(
    ollama?.models.map((m) => m.name.replace(/:latest$/, "")) ?? [],
  );

  return (
    <section style={cardStyle}>
      <h3 style={sectionTitleStyle}>
        <Brain size={14} /> Extrator de memórias (LLM)
      </h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        Quem analisa as conversas e cria as memórias estruturadas. Trocar o
        provider não derruba nada — o sistema continua usando heurística como
        fallback se o LLM escolhido não estiver disponível.
      </p>

      {/* Provider cards */}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        <ProviderCard
          title="OpenClaw CLI"
          subtitle="Modelos cloud do OpenClaw"
          tagline="qualidade alta · paga conforme seu modelo"
          icon={<ShieldCheck size={16} />}
          active={provider === "openclaw"}
          onClick={() => onSettingsChange({ extractor_provider: "openclaw" })}
        />
        <ProviderCard
          title="Ollama local"
          subtitle={ollama?.installed ? `v${ollama.version ?? "?"}` : "não detectado"}
          tagline="100% local · zero custo"
          icon={<Cpu size={16} />}
          active={provider === "ollama"}
          onClick={() => onSettingsChange({ extractor_provider: "ollama" })}
        />
        <ProviderCard
          title="Heurística"
          subtitle="sem LLM"
          tagline="regras simples · zero custo"
          icon={<Zap size={16} />}
          active={provider === "heuristic"}
          onClick={() => onSettingsChange({ extractor_provider: "heuristic" })}
        />
      </div>

      {/* Ollama detail panel */}
      {provider === "ollama" && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Status */}
          <div
            style={{
              padding: 10,
              borderRadius: 6,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {!ollama ? (
                <>Carregando status…</>
              ) : ollama.installed && ollama.running ? (
                <>
                  ✅ Ollama rodando em <code style={{ color: "var(--text-primary)" }}>{ollama.baseUrl}</code> · {ollama.models.length} modelo(s) local
                </>
              ) : ollama.installed && !ollama.running ? (
                <>
                  ⚠️ Ollama instalado mas não está respondendo em {ollama.baseUrl}. Use “Iniciar” abaixo ou verifique <code>journalctl -u ollama</code>.
                </>
              ) : (
                <>❌ Ollama não detectado. Instale para usar este modo.</>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={refreshStatus}
                disabled={loadingStatus}
                style={smallButtonStyle}
                title="Atualizar status"
              >
                {loadingStatus ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              </button>
              {ollama && !ollama.installed && ollama.platform === "linux" && (
                <button type="button" onClick={startInstall} style={primaryButtonStyle}>
                  <Download size={12} /> Instalar Ollama (Linux)
                </button>
              )}
            </div>
          </div>

          {/* Service control: start / stop / restart + enable-on-boot.
              Only shows when Ollama is installed AND systemd is reachable
              (Linux with the unit registered by the official installer). */}
          {ollama && ollama.installed && ollama.service.supported && (
            <div
              style={{
                padding: 10,
                borderRadius: 6,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Serviço <code style={{ color: "var(--text-primary)" }}>ollama.service</code>:{" "}
                  <strong style={{ color: ollama.service.active ? "var(--success, #32D74B)" : "var(--warning, #FFD60A)" }}>
                    {ollama.service.active ? "ativo" : "parado"}
                  </strong>
                  {" · "}
                  no boot:{" "}
                  <strong style={{ color: ollama.service.enabled ? "var(--success, #32D74B)" : "var(--text-muted)" }}>
                    {ollama.service.enabled ? "habilitado" : "desabilitado"}
                  </strong>
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {ollama.service.active ? (
                  <button
                    type="button"
                    onClick={() => runServiceAction("stop")}
                    disabled={serviceAction !== null}
                    style={smallButtonStyle}
                    title="Parar o daemon (corta extração até reiniciar)"
                  >
                    {serviceAction === "stop" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Pause size={12} />
                    )}
                    Parar
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => runServiceAction("start")}
                    disabled={serviceAction !== null}
                    style={primaryButtonStyle}
                  >
                    {serviceAction === "start" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Play size={12} />
                    )}
                    Iniciar
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => runServiceAction("restart")}
                  disabled={serviceAction !== null}
                  style={smallButtonStyle}
                  title="systemctl restart ollama"
                >
                  {serviceAction === "restart" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCw size={12} />
                  )}
                  Reiniciar
                </button>
                {ollama.service.enabled ? (
                  <button
                    type="button"
                    onClick={() => runServiceAction("disable")}
                    disabled={serviceAction !== null}
                    style={smallButtonStyle}
                    title="Não subir junto com o servidor"
                  >
                    {serviceAction === "disable" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <PowerOff size={12} />
                    )}
                    Não subir no boot
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => runServiceAction("enable")}
                    disabled={serviceAction !== null}
                    style={smallButtonStyle}
                    title="Subir junto com o servidor"
                  >
                    {serviceAction === "enable" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Play size={12} />
                    )}
                    Subir no boot
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Install log (when running) */}
          {install && (
            <div style={{ padding: 10, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, color: "var(--text-muted)" }}>
              <div style={{ marginBottom: 6, color: "var(--text-secondary)" }}>
                Instalação: <strong style={{ color: install.status === "ok" ? "var(--success, #32D74B)" : install.status === "fail" ? "var(--error, #FF453A)" : "var(--text-primary)" }}>{install.status}</strong>
              </div>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 120, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {install.logs || "(sem saída ainda)"}
              </pre>
              {install.error && (
                <div style={{ color: "var(--error, #FF453A)", marginTop: 4 }}>{install.error}</div>
              )}
            </div>
          )}

          {ollama && !ollama.installed && ollama.platform !== "linux" && (
            <div style={{ padding: 10, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--text-secondary)" }}>
              Auto-install só está disponível em Linux. Para {ollama.platform}: <span style={{ color: "var(--text-primary)" }}>{ollama.installHint}</span>
            </div>
          )}

          {/* Selected model */}
          <div style={{ padding: 10, borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
              Modelo ativo para extração
            </div>
            <div style={{ fontSize: 13, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
              {ollamaModel}{" "}
              {localModelNames.has(ollamaModel) ? (
                <span style={{ color: "var(--success, #32D74B)" }}>· instalado</span>
              ) : (
                <span style={{ color: "var(--warning, #FFD60A)" }}>· baixe abaixo</span>
              )}
            </div>
          </div>

          {/* Recommended models grid */}
          {ollama && (
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, fontWeight: 600 }}>
                Modelos recomendados
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                {ollama.recommended.map((m) => {
                  const isLocal = localModelNames.has(m.name);
                  const isActive = m.name === ollamaModel;
                  const pull = pulls[m.name];
                  return (
                    <div
                      key={m.name}
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        background: "var(--bg)",
                        border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span
                            title={`Qualidade ${QUALITY_LABEL[m.quality]}`}
                            style={{ width: 8, height: 8, borderRadius: 99, background: QUALITY_COLOR[m.quality] }}
                          />
                          <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>{m.label}</strong>
                        </div>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                          {m.name}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
                        {m.notes}
                      </div>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--text-muted)", flexWrap: "wrap" }}>
                        <span>params: <strong style={{ color: "var(--text-primary)" }}>{m.paramSize}</strong></span>
                        <span>disco: <strong style={{ color: "var(--text-primary)" }}>{m.diskGB} GB</strong></span>
                        <span>RAM: <strong style={{ color: "var(--text-primary)" }}>~{m.ramGB} GB</strong></span>
                      </div>

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {isLocal ? (
                          <button
                            type="button"
                            onClick={() => onSettingsChange({ ollama_model: m.name })}
                            disabled={isActive}
                            style={isActive ? activeButtonStyle : primaryButtonStyle}
                          >
                            {isActive ? "✓ Ativo" : "Usar este modelo"}
                          </button>
                        ) : pull?.status === "running" ? (
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                              {pull.message} · {pull.percent.toFixed(0)}%
                            </div>
                            <div style={{ height: 4, background: "var(--border)", borderRadius: 99, overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${pull.percent}%`,
                                  height: "100%",
                                  background: "var(--accent)",
                                  transition: "width 240ms ease",
                                }}
                              />
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startPull(m.name)}
                            disabled={!ollama.running}
                            title={!ollama.running ? "Ollama precisa estar rodando" : ""}
                            style={primaryButtonStyle}
                          >
                            <Download size={12} /> Baixar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Other locally-installed models not in our recommended list */}
          {ollama && ollama.models.filter((m) => !ollama.recommended.find((r) => r.name === m.name || r.name === m.name.replace(/:latest$/, ""))).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                Outros modelos instalados localmente
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {ollama.models
                  .filter((m) => !ollama.recommended.find((r) => r.name === m.name || r.name === m.name.replace(/:latest$/, "")))
                  .map((m) => (
                    <button
                      key={m.name}
                      type="button"
                      onClick={() => onSettingsChange({ ollama_model: m.name })}
                      style={{ ...smallButtonStyle, fontFamily: "var(--font-mono)" }}
                    >
                      {m.name} ({(m.size / 1024 ** 3).toFixed(1)} GB)
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  title,
  subtitle,
  tagline,
  icon,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  tagline: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 12,
        borderRadius: 8,
        background: active ? "var(--accent-soft, rgba(255,59,48,0.08))" : "var(--bg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        transition: "all 120ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: active ? "var(--accent)" : "var(--text-primary)" }}>
        {icon}
        <strong style={{ fontSize: 14 }}>{title}</strong>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{subtitle}</div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tagline}</div>
    </button>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 9px",
  borderRadius: 5,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--bg)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

const activeButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: "var(--bg)",
  color: "var(--accent)",
  cursor: "default",
};

const smallButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 8px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 11,
  cursor: "pointer",
};
