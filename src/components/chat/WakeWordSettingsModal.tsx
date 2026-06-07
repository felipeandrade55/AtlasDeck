"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";

type WakeEngine = "webspeech" | "openwakeword" | "porcupine";

interface WakeConfig {
  engine: WakeEngine;
  porcupine: {
    configured: boolean;
    accessKeyPreview: string | null;
    source: "env" | "memory_settings" | null;
    keyword: string;
    availableKeywords: string[];
  };
  openwakeword: {
    configured: boolean;
    keyword: string;
    threshold: number;
  };
}

interface WakeWordSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function WakeWordSettingsModal({ open, onClose }: WakeWordSettingsModalProps) {
  const [config, setConfig] = useState<WakeConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [engine, setEngine] = useState<WakeEngine>("webspeech");
  const [accessKey, setAccessKey] = useState("");
  const [keyword, setKeyword] = useState("Jarvis");
  const [threshold, setThreshold] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat/wake-config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WakeConfig;
      setConfig(data);
      setEngine(data.engine);
      setKeyword(data.porcupine.keyword || "Jarvis");
      setThreshold(data.openwakeword.threshold ?? 0.5);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
      setAccessKey("");
      setError(null);
    }
  }, [open, load]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = { engine };
      if (engine === "porcupine") {
        if (accessKey.trim()) patch.accessKey = accessKey.trim();
        if (keyword.trim()) patch.keyword = keyword.trim();
      } else {
        patch.openwakewordThreshold = threshold;
      }
      const res = await fetch("/api/chat/wake-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as WakeConfig;
      setConfig(data);
      setAccessKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [engine, accessKey, keyword, threshold]);

  const handleClearPorcupine = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/wake-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey: null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WakeConfig;
      setConfig(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <header style={modalHeaderStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Wake word</h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              Detecta &ldquo;Hey Jarvis&rdquo; acusticamente sem depender do ASR do Chrome.
            </p>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle}>
            <X size={18} />
          </button>
        </header>

        <div style={modalBodyStyle}>
          {loading && <div style={muted}>Carregando…</div>}

          {config && (
            <>
              <section style={fieldset}>
                <h3 style={sectionTitle}>Engine ativo</h3>
                <div style={engineGridStyle}>
                  <EngineCard
                    label="Web Speech pt-BR"
                    badge="Padrão · melhor para 'ei Jarvis'"
                    description="Usa o reconhecimento de fala do navegador em português do Brasil e aliases para Jarvis/Atlas. É o caminho mais confiável hoje para 'ei Jarvis'."
                    selected={engine === "webspeech"}
                    onClick={() => setEngine("webspeech")}
                  />
                  <EngineCard
                    label="openWakeWord"
                    badge="Apache 2.0 · modelo em inglês"
                    description="Modelos ONNX rodando 100% no browser. O modelo atual é 'hey_jarvis', então pode falhar com pronúncia pt-BR."
                    selected={engine === "openwakeword"}
                    onClick={() => setEngine("openwakeword")}
                  />
                  <EngineCard
                    label="Picovoice Porcupine"
                    badge="Free tier ≤3 users"
                    description="Engine comercial com tier grátis para uso pessoal. Mais preciso (<0.1 FA/h) mas exige conta no console.picovoice.ai."
                    selected={engine === "porcupine"}
                    onClick={() => setEngine("porcupine")}
                  />
                </div>
              </section>

              {engine === "webspeech" ? (
                <section style={statusBox(true)}>
                  <strong>✅ Pronto para pt-BR</strong>
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    Wake words aceitas: <code>ei Jarvis</code>, <code>Jarvis</code> e{" "}
                    <code>Atlas</code>, incluindo variações comuns que o Chrome costuma
                    transcrever.
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      style={primaryButton(saving)}
                    >
                      {saving ? "Salvando…" : "Salvar"}
                    </button>
                  </div>
                </section>
              ) : engine === "openwakeword" ? (
                <>
                  <section style={statusBox(config.openwakeword.configured)}>
                    <strong>
                      {config.openwakeword.configured ? "✅ Pronto" : "⚠ Modelos não encontrados"}
                    </strong>
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      Wake word: <code>hey_jarvis</code> (Apache-2.0, pré-treinado).
                      Modelos servidos de <code>/openwakeword/</code>.
                    </div>
                  </section>

                  <section style={fieldset}>
                    <h3 style={sectionTitle}>Sensibilidade</h3>
                    <label style={label}>
                      Threshold (atual: <strong>{threshold.toFixed(2)}</strong>)
                      <input
                        type="range"
                        min={0.1}
                        max={0.9}
                        step={0.05}
                        value={threshold}
                        onChange={(e) => setThreshold(Number(e.target.value))}
                        style={{ width: "100%" }}
                      />
                      <span style={{ ...muted, marginTop: 4 }}>
                        Menor = mais sensível (mais false-alarms). Maior = mais
                        rigoroso (pode perder wakes). <code>0.5</code> é o default
                        do openWakeWord.
                      </span>
                    </label>
                    <div style={buttonRow}>
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        style={primaryButton(saving)}
                      >
                        {saving ? "Salvando…" : "Salvar"}
                      </button>
                    </div>
                  </section>

                  <section style={fieldset}>
                    <h3 style={sectionTitle}>Como funciona</h3>
                    <p style={muted}>
                      openWakeWord roda 3 modelos ONNX no browser via
                      onnxruntime-web: melspectrogram → embedding → classifier.
                      Cada ~80ms ele avalia o áudio e emite uma probabilidade
                      de wake. Se passar do threshold, o AtlasDeck abre uma
                      janela de captura via Web Speech (que é boa para frases
                      completas) para o comando.
                    </p>
                    <p style={muted}>
                      Acurácia esperada: ~95% recall com ~0.3 false-alarms/hora.
                      Treinar uma wake word custom (ex: &ldquo;Atlas&rdquo;) é
                      possível via Google Colab do openWakeWord — fica como
                      upgrade futuro.
                    </p>
                  </section>
                </>
              ) : (
                <>
                  <section style={statusBox(config.porcupine.configured)}>
                    <strong>
                      {config.porcupine.configured
                        ? "✅ Configurado"
                        : "⚠ AccessKey necessária"}
                    </strong>
                    {config.porcupine.configured && (
                      <div style={{ marginTop: 4, fontSize: 12 }}>
                        Fonte: <code>{config.porcupine.source}</code> · access
                        key <code>{config.porcupine.accessKeyPreview}</code> ·
                        keyword <code>{config.porcupine.keyword}</code>
                      </div>
                    )}
                  </section>

                  <section style={fieldset}>
                    <h3 style={sectionTitle}>Como obter a AccessKey</h3>
                    <ol style={stepsStyle}>
                      <li>
                        Acesse{" "}
                        <a
                          href="https://console.picovoice.ai/"
                          target="_blank"
                          rel="noreferrer"
                          style={linkStyle}
                        >
                          console.picovoice.ai <ExternalLink size={10} />
                        </a>{" "}
                        e cria conta grátis (sem cartão)
                      </li>
                      <li>Copia o AccessKey do dashboard</li>
                      <li>Cola abaixo + salva</li>
                    </ol>
                  </section>

                  <section style={fieldset}>
                    <h3 style={sectionTitle}>Credenciais</h3>

                    <label style={label}>
                      AccessKey (Picovoice)
                      <input
                        type="password"
                        placeholder={
                          config.porcupine.configured
                            ? "(salva — apague para limpar ou cole nova)"
                            : "AccessKey copiada do dashboard"
                        }
                        value={accessKey}
                        onChange={(e) => setAccessKey(e.target.value)}
                        style={input}
                      />
                    </label>

                    <label style={label}>
                      Palavra-gatilho
                      <select
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        style={input}
                      >
                        {config.porcupine.availableKeywords.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div style={buttonRow}>
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        style={primaryButton(saving)}
                      >
                        {saving ? "Salvando…" : "Salvar"}
                      </button>
                      {config.porcupine.configured &&
                        config.porcupine.source === "memory_settings" && (
                          <button
                            type="button"
                            onClick={handleClearPorcupine}
                            disabled={saving}
                            style={secondaryButton(saving)}
                          >
                            Remover access key
                          </button>
                        )}
                    </div>
                  </section>
                </>
              )}

              {error && <div style={errorBox}>⚠ {error}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EngineCard({
  label,
  badge,
  description,
  selected,
  onClick,
}: {
  label: string;
  badge: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: 12,
        borderRadius: 8,
        background: selected ? "var(--accent-soft)" : "var(--bg)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {selected && (
          <CheckCircle2
            size={14}
            style={{ color: "var(--accent)", flexShrink: 0 }}
          />
        )}
        <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: 0.3 }}>
        {badge}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
        {description}
      </div>
    </button>
  );
}

const engineGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 8,
};

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const modalStyle: CSSProperties = {
  width: "min(680px, 95vw)",
  maxHeight: "85vh",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const modalHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  padding: 16,
  borderBottom: "1px solid var(--border)",
};

const modalBodyStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const iconButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 8,
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

function statusBox(ok: boolean): CSSProperties {
  return {
    padding: "10px 12px",
    background: ok
      ? "var(--accent-soft)"
      : "var(--danger-soft, rgba(239,68,68,0.1))",
    border: `1px solid ${ok ? "var(--accent)" : "var(--danger, #ef4444)"}`,
    borderRadius: 8,
    color: ok ? "var(--accent)" : "var(--danger, #ef4444)",
  };
}

const fieldset: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg)",
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const muted: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  margin: 0,
  lineHeight: 1.5,
};

const stepsStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 12,
  color: "var(--text-primary)",
  lineHeight: 1.7,
};

const linkStyle: CSSProperties = {
  color: "var(--accent)",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const label: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
};

const input: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};

const buttonRow: CSSProperties = {
  display: "flex",
  gap: 8,
};

function primaryButton(disabled?: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 8,
    background: disabled ? "var(--surface)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "#fff",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    fontWeight: 500,
  };
}

function secondaryButton(disabled?: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 8,
    background: "var(--bg)",
    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
    border: "1px solid var(--border)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
  };
}

const errorBox: CSSProperties = {
  padding: "8px 10px",
  background: "var(--danger-soft, rgba(239,68,68,0.1))",
  border: "1px solid var(--danger, #ef4444)",
  borderRadius: 6,
  color: "var(--danger, #ef4444)",
  fontSize: 12,
};
