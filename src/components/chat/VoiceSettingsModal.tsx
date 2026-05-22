"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CheckCircle2, Volume2, X } from "lucide-react";

interface ProbedPath {
  path: string;
  exists: boolean;
  hasApiKey: boolean;
  hasVoiceId: boolean;
  apiKeyPreview: string | null;
  voiceIdPreview: string | null;
}

interface Diagnostic {
  configured: boolean;
  voiceId: string | null;
  modelId: string | null;
  source: string | null;
  openclawJsonPath: string | null;
  openclawJsonExists: boolean;
  envHasApiKey: boolean;
  envHasVoiceId: boolean;
  memorySettingsHasApiKey: boolean;
  memorySettingsHasVoiceId: boolean;
  probedPaths: ProbedPath[];
}

interface VoiceSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function VoiceSettingsModal({ open, onClose }: VoiceSettingsModalProps) {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState("eleven_multilingual_v2");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat/tts/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Diagnostic;
      setDiag(data);
      if (data.voiceId) setVoiceId(data.voiceId);
      if (data.modelId) setModelId(data.modelId);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
      setApiKey("");
      setTestError(null);
    }
  }, [open, load]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const patch: Record<string, string | null> = {};
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (voiceId.trim()) patch.voiceId = voiceId.trim();
      if (modelId.trim()) patch.modelId = modelId.trim();
      const res = await fetch("/api/chat/tts/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Diagnostic;
      setDiag(data);
      setApiKey("");
    } catch (err) {
      setTestError(`Falha ao salvar: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [apiKey, voiceId, modelId]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    try {
      const res = await fetch("/api/chat/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Olá Felipe, voz funcionando perfeitamente." }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setTestError(`Teste falhou: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <header style={modalHeaderStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Voz do Jarvis (ElevenLabs)
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              Use a mesma voz do seu agente no Telegram.
            </p>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle}>
            <X size={18} />
          </button>
        </header>

        <div style={modalBodyStyle}>
          {loading && <div style={muted}>Carregando…</div>}

          {diag && (
            <>
              <section style={statusBox(diag.configured)}>
                <strong>
                  {diag.configured ? "✅ Configurado" : "⚠ Não configurado"}
                </strong>
                {diag.configured && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    Fonte: <code>{diag.source}</code> · voiceId{" "}
                    <code>{diag.voiceId}</code> · model{" "}
                    <code>{diag.modelId}</code>
                  </div>
                )}
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Configurar via AtlasDeck</h3>
                <p style={muted}>
                  Salva em <code>memory_settings</code>. Sobrescreve detecções
                  do <code>openclaw.json</code>.
                </p>

                <label style={label}>
                  API key
                  <input
                    type="password"
                    placeholder={
                      diag.memorySettingsHasApiKey
                        ? "(salva — apague para limpar)"
                        : "sk_..."
                    }
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Voice ID
                  <input
                    type="text"
                    placeholder="ex: 21m00Tcm4TlvDq8ikWAM"
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Model ID
                  <input
                    type="text"
                    placeholder="eleven_multilingual_v2"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    style={input}
                  />
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
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !diag.configured}
                    style={secondaryButton(testing || !diag.configured)}
                    title={
                      diag.configured
                        ? "Toca uma frase teste com a voz configurada"
                        : "Configure antes de testar"
                    }
                  >
                    <Volume2 size={14} />
                    {testing ? "Tocando…" : "Testar voz"}
                  </button>
                </div>
                {testError && <div style={errorBox}>⚠ {testError}</div>}
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Diagnóstico</h3>
                <ul style={diagList}>
                  <li>
                    <DiagDot ok={diag.envHasApiKey} />
                    ENV <code>ELEVENLABS_API_KEY</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.envHasVoiceId} />
                    ENV <code>ELEVENLABS_VOICE_ID</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.memorySettingsHasApiKey} />
                    memory_settings.api_key
                  </li>
                  <li>
                    <DiagDot ok={diag.memorySettingsHasVoiceId} />
                    memory_settings.voice_id
                  </li>
                  <li>
                    <DiagDot ok={diag.openclawJsonExists} />
                    <code>{diag.openclawJsonPath ?? "openclaw.json"}</code>{" "}
                    {diag.openclawJsonExists ? "encontrado" : "ausente"}
                  </li>
                </ul>

                {diag.openclawJsonExists && (
                  <>
                    <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-secondary)" }}>
                      Caminhos probados em <code>openclaw.json</code>:
                    </div>
                    <ul style={diagList}>
                      {diag.probedPaths.map((p) => (
                        <li key={p.path}>
                          <DiagDot ok={p.exists && p.hasApiKey && p.hasVoiceId} />
                          <code>{p.path}</code>
                          {p.exists && (
                            <span style={muted}>
                              {" "}
                              · api={p.apiKeyPreview ?? "—"} · voice=
                              {p.voiceIdPreview ?? "—"}
                            </span>
                          )}
                          {!p.exists && <span style={muted}> · ausente</span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <details style={{ marginTop: 10, fontSize: 11 }}>
                  <summary style={{ cursor: "pointer", color: "var(--text-secondary)" }}>
                    Não vê seu path? Clique aqui
                  </summary>
                  <p style={{ ...muted, marginTop: 6 }}>
                    Hoje probamos: <code>channels.elevenlabs</code>,{" "}
                    <code>channels.eleven_labs</code>,{" "}
                    <code>integrations.*</code>, <code>voice.*</code>,{" "}
                    <code>tts.*</code> com chaves <code>apiKey</code>/
                    <code>api_key</code>/<code>key</code> e{" "}
                    <code>voiceId</code>/<code>voice_id</code>/
                    <code>voice</code>. Se o seu OpenClaw armazena em outro
                    lugar, cole manualmente acima ou exporte as ENVs{" "}
                    <code>ELEVENLABS_API_KEY</code> /{" "}
                    <code>ELEVENLABS_VOICE_ID</code> no service do
                    mission-control.
                  </p>
                </details>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DiagDot({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 size={12} style={{ color: "#22c55e", marginRight: 6 }} />
  ) : (
    <span style={{ display: "inline-block", width: 12, marginRight: 6 }}>·</span>
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
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 8,
    background: "var(--bg)",
    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
    border: "1px solid var(--border)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
  };
}

const diagList: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "6px 0 0 0",
  fontSize: 11,
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const errorBox: CSSProperties = {
  padding: "8px 10px",
  background: "var(--danger-soft, rgba(239,68,68,0.1))",
  border: "1px solid var(--danger, #ef4444)",
  borderRadius: 6,
  color: "var(--danger, #ef4444)",
  fontSize: 12,
};
