"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";

interface WakeConfig {
  configured: boolean;
  accessKeyPreview: string | null;
  source: "env" | "memory_settings" | null;
  keyword: string;
  availableKeywords: string[];
}

interface WakeWordSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function WakeWordSettingsModal({ open, onClose }: WakeWordSettingsModalProps) {
  const [config, setConfig] = useState<WakeConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [keyword, setKeyword] = useState("Jarvis");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat/wake-config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WakeConfig;
      setConfig(data);
      if (data.keyword) setKeyword(data.keyword);
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
      const patch: Record<string, string | null> = {};
      if (accessKey.trim()) patch.accessKey = accessKey.trim();
      if (keyword.trim()) patch.keyword = keyword.trim();
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
  }, [accessKey, keyword]);

  const handleClear = useCallback(async () => {
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
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Wake word (Picovoice Porcupine)
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              Detector acústico que reconhece &ldquo;Jarvis&rdquo; sem depender do ASR do Chrome.
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
              <section style={statusBox(config.configured)}>
                <strong>
                  {config.configured ? "✅ Configurado" : "⚠ Não configurado"}
                </strong>
                {config.configured && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    Fonte: <code>{config.source}</code> · access key{" "}
                    <code>{config.accessKeyPreview}</code> · keyword{" "}
                    <code>{config.keyword}</code>
                  </div>
                )}
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Como configurar</h3>
                <ol style={stepsStyle}>
                  <li>
                    Acesse{" "}
                    <a
                      href="https://console.picovoice.ai/"
                      target="_blank"
                      rel="noreferrer"
                      style={linkStyle}
                    >
                      console.picovoice.ai{" "}
                      <ExternalLink size={10} />
                    </a>{" "}
                    e crie uma conta grátis
                  </li>
                  <li>Copie o AccessKey do dashboard</li>
                  <li>Cole no campo abaixo + salve</li>
                  <li>
                    Recarregue o /chat — o badge Wake muda para verde
                    &ldquo;Porcupine ativo&rdquo;
                  </li>
                </ol>
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Credenciais</h3>

                <label style={label}>
                  AccessKey (Picovoice)
                  <input
                    type="password"
                    placeholder={
                      config.configured
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
                    {config.availableKeywords.map((k) => (
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
                  {config.configured && config.source === "memory_settings" && (
                    <button
                      type="button"
                      onClick={handleClear}
                      disabled={saving}
                      style={secondaryButton(saving)}
                    >
                      Remover
                    </button>
                  )}
                </div>
                {error && <div style={errorBox}>⚠ {error}</div>}
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Como funciona</h3>
                <p style={muted}>
                  Porcupine faz reconhecimento <strong>acústico</strong> direto
                  do áudio do microfone — não depende do Web Speech transcrever
                  &ldquo;Jarvis&rdquo; corretamente. Quando detecta a
                  palavra-gatilho, o AtlasDeck abre uma janela de captura via
                  Web Speech para você falar o comando (o ASR pt-BR é bom para
                  frases completas, só falha em palavras isoladas).
                </p>
                <p style={muted}>
                  Sem AccessKey configurada, voltamos a usar Web Speech também
                  para o wake — o que muitas vezes falha de pegar
                  &ldquo;Jarvis&rdquo;/&ldquo;Atlas&rdquo;.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
  width: "min(640px, 95vw)",
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
    background: ok ? "var(--accent-soft)" : "var(--danger-soft, rgba(239,68,68,0.1))",
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

// Suppress unused warning for the imported icon when no checkmark is rendered.
void CheckCircle2;
