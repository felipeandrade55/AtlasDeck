"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Cloud, Copy, Cpu, ExternalLink, Loader2, LogIn } from "lucide-react";
import type { SetupStatus } from "../SetupStepper";
import { KNOWN_MODELS } from "@/lib/openclaw-models";

type Mode = "choose" | "local" | "cloud" | "oauth";
type CloudProvider = "anthropic" | "openai" | "google";

interface OAuthSnap {
  status: "idle" | "starting" | "awaiting" | "success" | "error";
  verificationUrl?: string | null;
  userCode?: string | null;
  error?: string | null;
}

interface Props {
  status: SetupStatus;
  onAdvance: () => void;
}

const CLOUD_TABS: Array<{ id: CloudProvider; label: string; placeholder: string; helpUrl: string }> = [
  { id: "anthropic", label: "Anthropic (Claude)", placeholder: "sk-ant-…", helpUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI (GPT)", placeholder: "sk-…", helpUrl: "https://platform.openai.com/api-keys" },
  { id: "google", label: "Google (Gemini)", placeholder: "AIza…", helpUrl: "https://aistudio.google.com/apikey" },
];

export function AiProviderStep({ status, onAdvance }: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [tab, setTab] = useState<CloudProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthSnap | null>(null);

  // Poll the device-code session while the user authorizes in the browser.
  useEffect(() => {
    if (mode !== "oauth" || !oauth) return;
    if (oauth.status === "success") {
      onAdvance();
      return;
    }
    if (oauth.status === "error" || oauth.status === "idle") return;
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/setup/ai-provider/oauth/poll", { cache: "no-store" });
        const json = (await res.json()) as OAuthSnap;
        setOauth(json);
        if (json.status === "success") {
          clearInterval(t);
          onAdvance();
        }
      } catch {
        // transient — keep polling
      }
    }, 2500);
    return () => clearInterval(t);
  }, [mode, oauth, onAdvance]);

  async function startOAuth() {
    setMode("oauth");
    setOauth({ status: "starting" });
    try {
      const res = await fetch("/api/setup/ai-provider/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      const json = (await res.json()) as OAuthSnap;
      setOauth(json);
    } catch (e) {
      setOauth({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function cancelOAuth() {
    try {
      await fetch("/api/setup/ai-provider/oauth/cancel", { method: "POST" });
    } catch {
      // ignore
    }
    setOauth(null);
    setMode("choose");
  }

  const cloudModels = useMemo(() => KNOWN_MODELS.filter((m) => m.provider === tab), [tab]);
  const ollamaModels = useMemo(() => KNOWN_MODELS.filter((m) => m.provider === "ollama"), []);

  async function testKey() {
    setBusy("test");
    setTestResult(null);
    try {
      const res = await fetch("/api/setup/ai-provider?action=test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: tab, apiKey: apiKey.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setTestResult({ ok: true, models: json.sampleModels ?? [] });
      } else {
        setTestResult({ ok: false, error: json.error ?? "Falha no teste" });
      }
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function save(provider: CloudProvider | "ollama", model: string) {
    setBusy("save");
    setSaveError(null);
    try {
      const body: { provider: string; modelId: string; apiKey?: string } = {
        provider,
        modelId: model,
      };
      if (provider !== "ollama") body.apiKey = apiKey.trim();

      const res = await fetch("/api/setup/ai-provider?action=save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setSaveError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      onAdvance();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Conectar um modelo de IA
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          Escolha entre rodar local com Ollama (gratuito, offline) ou conectar a um provider de nuvem
          (Anthropic, OpenAI, Google). Pode mudar depois em <code>/agents</code>.
        </p>
      </div>

      {status.ai.configured && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            background: "rgba(50,215,75,0.08)",
            border: "1px solid var(--success, #32D74B)",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          <CheckCircle2 size={16} style={{ color: "var(--success, #32D74B)" }} />
          <div style={{ flex: 1 }}>
            <strong>Modelo já configurado:</strong> <code>{status.ai.primaryModel}</code>
          </div>
          <button type="button" onClick={onAdvance} style={primaryBtn}>
            Avançar →
          </button>
        </div>
      )}

      {mode === "choose" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <ChoiceCard
            icon={LogIn}
            title="Entrar com OpenAI"
            badge="Recomendado"
            body="Conecte sua conta OpenAI por um link seguro — sem colar chave nem mexer em terminal. Mostramos um link e um código; você autoriza no navegador."
            footer="Usa sua assinatura ChatGPT/OpenAI (login OAuth)"
            onClick={startOAuth}
          />
          <ChoiceCard
            icon={Cpu}
            title="Local com Ollama"
            badge="Gratuito"
            body="Roda 100% no seu hardware. Sem API key, sem custo. Precisa de Ollama instalado (detectamos abaixo)."
            footer={
              status.ai.ollama.running
                ? `Ollama ativo · ${status.ai.ollama.modelsCount} modelos`
                : status.ai.ollama.installed
                ? "Ollama instalado mas parado"
                : "Ollama não detectado"
            }
            onClick={() => setMode("local")}
          />
          <ChoiceCard
            icon={Cloud}
            title="Nuvem (API key)"
            badge="Mais inteligente"
            body="Anthropic Claude, OpenAI GPT ou Google Gemini. Você cola a chave aqui e a gente valida antes de salvar."
            footer="Pago por uso — defina orçamento em /costs depois"
            onClick={() => setMode("cloud")}
          />
        </div>
      )}

      {mode === "oauth" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <BackLink onClick={cancelOAuth} />

          {(!oauth || oauth.status === "starting") && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-secondary)", fontSize: 13.5 }}>
              <Loader2 size={16} className="spin" /> Preparando o login seguro com a OpenAI…
            </div>
          )}

          {oauth && oauth.status === "awaiting" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
                Falta só autorizar no navegador. É rápido:
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Step n={1} label="Abra a página de autorização da OpenAI">
                  {oauth.verificationUrl ? (
                    <a href={oauth.verificationUrl} target="_blank" rel="noreferrer" style={linkBtn}>
                      <ExternalLink size={14} /> Abrir página de login
                    </a>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>aguardando link…</span>
                  )}
                </Step>

                <Step n={2} label="Digite (ou cole) este código quando pedirem">
                  {oauth.userCode ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <code
                        style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: 22,
                          fontWeight: 700,
                          letterSpacing: "0.12em",
                          color: "var(--text-primary)",
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: "8px 14px",
                        }}
                      >
                        {oauth.userCode}
                      </code>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(oauth.userCode || "")}
                        style={ghostBtn}
                        title="Copiar código"
                      >
                        <Copy size={14} /> Copiar
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>aguardando código…</span>
                  )}
                </Step>

                <Step n={3} label="Autorize — detectamos automaticamente">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13 }}>
                    <Loader2 size={14} className="spin" /> Aguardando sua autorização…
                  </span>
                </Step>
              </div>
            </div>
          )}

          {oauth && oauth.status === "error" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Notice variant="error">
                {oauth.error || "Não consegui concluir o login."} Você pode tentar de novo ou usar uma chave de API.
              </Notice>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={primaryBtn} onClick={startOAuth}>
                  Tentar novamente
                </button>
                <button type="button" style={ghostBtn} onClick={() => { setOauth(null); setMode("cloud"); }}>
                  Usar chave de API
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "local" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <BackLink onClick={() => setMode("choose")} />
          {!status.ai.ollama.installed && (
            <Notice variant="warning">
              Ollama não foi detectado. Instale-o em <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a> ou vá em
              <strong> Memória → Configurações → Instalar Ollama (Linux)</strong> e volte aqui depois.
            </Notice>
          )}
          {status.ai.ollama.installed && !status.ai.ollama.running && (
            <Notice variant="warning">
              Ollama está instalado mas o serviço não está rodando. Rode <code>ollama serve</code> ou ative o serviço systemd.
            </Notice>
          )}
          <ModelPicker
            models={ollamaModels}
            value={modelId}
            onChange={setModelId}
            placeholder="Selecione um modelo Ollama (precisa estar puxado: ollama pull …)"
          />
          {modelId && (
            <Notice variant="info">
              Se ainda não baixou esse modelo, rode no terminal: <code>ollama pull {modelId.replace(/^ollama\//, "")}</code>. Pode demorar.
            </Notice>
          )}
          {saveError && <Notice variant="error">{saveError}</Notice>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={primaryBtn}
              disabled={!modelId || busy === "save"}
              onClick={() => save("ollama", modelId)}
            >
              {busy === "save" ? <Loader2 size={14} className="spin" /> : null} Salvar e continuar
            </button>
          </div>
        </div>
      )}

      {mode === "cloud" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <BackLink onClick={() => setMode("choose")} />
          <div style={{ display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 10, border: "1px solid var(--border)" }}>
            {CLOUD_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  setTestResult(null);
                  setApiKey("");
                  setModelId("");
                }}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "none",
                  borderRadius: 6,
                  background: tab === t.id ? "var(--card)" : "transparent",
                  color: tab === t.id ? "var(--text-primary)" : "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: tab === t.id ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              API key — obtenha em{" "}
              <a href={CLOUD_TABS.find((t) => t.id === tab)?.helpUrl} target="_blank" rel="noreferrer">
                {CLOUD_TABS.find((t) => t.id === tab)?.helpUrl.replace(/^https?:\/\//, "")}
              </a>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestResult(null);
              }}
              placeholder={CLOUD_TABS.find((t) => t.id === tab)?.placeholder}
              style={inputStyle}
              autoComplete="off"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={testKey}
                disabled={!apiKey.trim() || busy === "test"}
                style={ghostBtn}
              >
                {busy === "test" ? <Loader2 size={14} className="spin" /> : null} Testar conexão
              </button>
              {testResult?.ok && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    color: "var(--success, #32D74B)",
                    fontSize: 12.5,
                  }}
                >
                  <CheckCircle2 size={14} /> Chave válida
                </span>
              )}
              {testResult && !testResult.ok && (
                <span style={{ color: "var(--danger, #FF3B30)", fontSize: 12.5 }}>{testResult.error}</span>
              )}
            </div>
          </div>

          <ModelPicker
            models={cloudModels}
            value={modelId}
            onChange={setModelId}
            placeholder="Selecione um modelo"
            disabled={!testResult?.ok}
          />

          {saveError && <Notice variant="error">{saveError}</Notice>}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={primaryBtn}
              disabled={!testResult?.ok || !modelId || busy === "save"}
              onClick={() => save(tab, modelId)}
            >
              {busy === "save" ? <Loader2 size={14} className="spin" /> : null} Salvar e continuar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  body,
  badge,
  footer,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  body: string;
  badge: string;
  footer: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon size={18} style={{ color: "var(--accent)" }} />
        <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{title}</strong>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontWeight: 700,
            color: "var(--accent)",
            background: "rgba(255,59,48,0.1)",
            padding: "2px 8px",
            borderRadius: 999,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {badge}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>{body}</p>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{footer}</span>
    </button>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  models: typeof KNOWN_MODELS;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Modelo</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...inputStyle, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}
      >
        <option value="">{placeholder}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Notice({
  variant,
  children,
}: {
  variant: "info" | "warning" | "error";
  children: React.ReactNode;
}) {
  const tone = {
    info: { bg: "rgba(10,132,255,0.08)", border: "rgba(10,132,255,0.4)", color: "#60a5fa" },
    warning: { bg: "rgba(255,214,10,0.08)", border: "rgba(255,214,10,0.4)", color: "#fbbf24" },
    error: { bg: "rgba(255,59,48,0.08)", border: "var(--danger, #FF3B30)", color: "var(--danger, #FF3B30)" },
  }[variant];
  return (
    <div
      style={{
        padding: "10px 14px",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 10,
        color: tone.color,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", alignSelf: "flex-start", padding: 0 }}
    >
      ← Trocar de opção
    </button>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: 999,
          background: "var(--accent)",
          color: "var(--bg)",
          fontWeight: 700,
          fontSize: 12,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {n}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{label}</span>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 16px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--bg)",
  border: "none",
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "9px 14px",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  fontSize: 12.5,
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 16px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--bg)",
  border: "none",
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
  width: "fit-content",
};
