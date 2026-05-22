"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CheckCircle2, Volume2, X } from "lucide-react";

type TtsProvider = "elevenlabs" | "fishaudio";

interface ElevenProbedPath {
  path: string;
  exists: boolean;
  hasApiKey: boolean;
  hasVoiceId: boolean;
  apiKeyPreview: string | null;
  voiceIdPreview: string | null;
}

interface ElevenDiag {
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
  probedPaths: ElevenProbedPath[];
}

interface FishDiag {
  configured: boolean;
  hasVoiceId: boolean;
  voiceId: string | null;
  model: string | null;
  source: string | null;
  envHasApiKey: boolean;
  envHasVoiceId: boolean;
  memorySettingsHasApiKey: boolean;
  memorySettingsHasVoiceId: boolean;
}

interface FullDiag {
  provider: TtsProvider;
  elevenlabs: ElevenDiag;
  fishaudio: FishDiag;
}

interface VoiceSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function VoiceSettingsModal({ open, onClose }: VoiceSettingsModalProps) {
  const [diag, setDiag] = useState<FullDiag | null>(null);
  const [loading, setLoading] = useState(false);

  const [provider, setProvider] = useState<TtsProvider>("elevenlabs");

  const [elevenApiKey, setElevenApiKey] = useState("");
  const [elevenVoiceId, setElevenVoiceId] = useState("");
  const [elevenModelId, setElevenModelId] = useState("eleven_multilingual_v2");

  const [fishApiKey, setFishApiKey] = useState("");
  const [fishVoiceId, setFishVoiceId] = useState("");
  const [fishModel, setFishModel] = useState("s2-pro");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat/tts/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FullDiag;
      setDiag(data);
      setProvider(data.provider);
      if (data.elevenlabs.voiceId) setElevenVoiceId(data.elevenlabs.voiceId);
      if (data.elevenlabs.modelId) setElevenModelId(data.elevenlabs.modelId);
      if (data.fishaudio.voiceId) setFishVoiceId(data.fishaudio.voiceId);
      if (data.fishaudio.model) setFishModel(data.fishaudio.model);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
      setElevenApiKey("");
      setFishApiKey("");
      setTestError(null);
      setTestNote(null);
    }
  }, [open, load]);

  const handleSwitchProvider = useCallback(async (next: TtsProvider) => {
    setProvider(next);
    setTestError(null);
    setTestNote(null);
    try {
      const res = await fetch("/api/chat/tts/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FullDiag;
      setDiag(data);
    } catch (err) {
      setTestError(`Falha ao trocar provider: ${(err as Error).message}`);
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setTestError(null);
    setTestNote(null);
    try {
      const patch: Record<string, unknown> = { provider };
      const eleven: Record<string, string | null> = {};
      if (elevenApiKey.trim()) eleven.apiKey = elevenApiKey.trim();
      if (elevenVoiceId.trim()) eleven.voiceId = elevenVoiceId.trim();
      if (elevenModelId.trim()) eleven.modelId = elevenModelId.trim();
      if (Object.keys(eleven).length > 0) patch.elevenlabs = eleven;

      const fish: Record<string, string | null> = {};
      if (fishApiKey.trim()) fish.apiKey = fishApiKey.trim();
      // voiceId is optional: send always so blank = clear (allows "qualquer voz")
      fish.voiceId = fishVoiceId.trim() ? fishVoiceId.trim() : null;
      if (fishModel.trim()) fish.model = fishModel.trim();
      if (fishApiKey.trim() || fishVoiceId !== "" || fishModel.trim()) {
        patch.fishaudio = fish;
      }

      const res = await fetch("/api/chat/tts/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FullDiag;
      setDiag(data);
      setElevenApiKey("");
      setFishApiKey("");
      setTestNote("Salvo.");
    } catch (err) {
      setTestError(`Falha ao salvar: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [
    provider,
    elevenApiKey,
    elevenVoiceId,
    elevenModelId,
    fishApiKey,
    fishVoiceId,
    fishModel,
  ]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    setTestNote(null);
    try {
      const res = await fetch("/api/chat/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Olá Felipe, voz funcionando perfeitamente.",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      const usedProvider = res.headers.get("x-tts-provider");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setTestNote(`Tocando via ${usedProvider ?? "?"}.`);
    } catch (err) {
      setTestError(`Teste falhou: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  }, []);

  if (!open) return null;

  const elevenAvailable = diag?.elevenlabs.configured ?? false;
  const fishAvailable = diag?.fishaudio.configured ?? false;
  const activeAvailable =
    provider === "elevenlabs" ? elevenAvailable : fishAvailable;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <header style={modalHeaderStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Voz do Jarvis
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              Escolha entre ElevenLabs e Fish Audio. Mantenha os dois
              configurados para alternar com um clique.
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
              <section style={fieldset}>
                <h3 style={sectionTitle}>Provider ativo</h3>
                <div style={providerRow}>
                  <ProviderButton
                    label="ElevenLabs"
                    sub={
                      elevenAvailable
                        ? diag.elevenlabs.voiceId
                          ? `voz ${diag.elevenlabs.voiceId.slice(0, 8)}…`
                          : "configurado"
                        : "não configurado"
                    }
                    available={elevenAvailable}
                    active={provider === "elevenlabs"}
                    onClick={() => void handleSwitchProvider("elevenlabs")}
                  />
                  <ProviderButton
                    label="Fish Audio"
                    sub={
                      fishAvailable
                        ? diag.fishaudio.voiceId
                          ? `voz ${diag.fishaudio.voiceId.slice(0, 8)}…`
                          : "voz padrão"
                        : "não configurado"
                    }
                    available={fishAvailable}
                    active={provider === "fishaudio"}
                    onClick={() => void handleSwitchProvider("fishaudio")}
                  />
                </div>
                {!activeAvailable && (
                  <div style={warningBox}>
                    O provider selecionado ainda não está configurado. Use o
                    formulário abaixo para colar a API key.
                  </div>
                )}
                <div style={buttonRow}>
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !activeAvailable}
                    style={secondaryButton(testing || !activeAvailable)}
                    title={
                      activeAvailable
                        ? "Toca uma frase teste com o provider ativo"
                        : "Configure antes de testar"
                    }
                  >
                    <Volume2 size={14} />
                    {testing ? "Tocando…" : "Testar voz"}
                  </button>
                </div>
                {testNote && <div style={successBox}>✓ {testNote}</div>}
                {testError && <div style={errorBox}>⚠ {testError}</div>}
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>ElevenLabs</h3>
                <p style={muted}>
                  Mesma voz usada no Telegram. Sobrescreve detecções do{" "}
                  <code>openclaw.json</code>.
                </p>

                <label style={label}>
                  API key
                  <input
                    type="password"
                    placeholder={
                      diag.elevenlabs.memorySettingsHasApiKey
                        ? "(salva — cole nova ou deixe vazio)"
                        : "sk_..."
                    }
                    value={elevenApiKey}
                    onChange={(e) => setElevenApiKey(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Voice ID
                  <input
                    type="text"
                    placeholder="ex: 21m00Tcm4TlvDq8ikWAM"
                    value={elevenVoiceId}
                    onChange={(e) => setElevenVoiceId(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Model ID
                  <input
                    type="text"
                    placeholder="eleven_multilingual_v2"
                    value={elevenModelId}
                    onChange={(e) => setElevenModelId(e.target.value)}
                    style={input}
                  />
                </label>

                <ul style={diagList}>
                  <li>
                    <DiagDot ok={diag.elevenlabs.envHasApiKey} />
                    ENV <code>ELEVENLABS_API_KEY</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.elevenlabs.envHasVoiceId} />
                    ENV <code>ELEVENLABS_VOICE_ID</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.elevenlabs.memorySettingsHasApiKey} />
                    memory_settings.api_key
                  </li>
                  <li>
                    <DiagDot ok={diag.elevenlabs.memorySettingsHasVoiceId} />
                    memory_settings.voice_id
                  </li>
                  <li>
                    <DiagDot ok={diag.elevenlabs.openclawJsonExists} />
                    <code>{diag.elevenlabs.openclawJsonPath ?? "openclaw.json"}</code>{" "}
                    {diag.elevenlabs.openclawJsonExists ? "encontrado" : "ausente"}
                  </li>
                </ul>
              </section>

              <section style={fieldset}>
                <h3 style={sectionTitle}>Fish Audio</h3>
                <p style={muted}>
                  Bearer token do Fish Audio. Se deixar o Voice ID vazio,
                  o Fish Audio usa uma voz padrão.
                </p>

                <label style={label}>
                  API key
                  <input
                    type="password"
                    placeholder={
                      diag.fishaudio.memorySettingsHasApiKey
                        ? "(salva — cole nova ou deixe vazio)"
                        : "61e3cf7b..."
                    }
                    value={fishApiKey}
                    onChange={(e) => setFishApiKey(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Voice ID <span style={muted}>(opcional)</span>
                  <input
                    type="text"
                    placeholder="ex: a5b93aeddcc948c19ea04f0afe9d178c"
                    value={fishVoiceId}
                    onChange={(e) => setFishVoiceId(e.target.value)}
                    style={input}
                  />
                </label>

                <label style={label}>
                  Model
                  <input
                    type="text"
                    placeholder="s2-pro"
                    value={fishModel}
                    onChange={(e) => setFishModel(e.target.value)}
                    style={input}
                  />
                </label>

                <ul style={diagList}>
                  <li>
                    <DiagDot ok={diag.fishaudio.envHasApiKey} />
                    ENV <code>FISHAUDIO_API_KEY</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.fishaudio.envHasVoiceId} />
                    ENV <code>FISHAUDIO_VOICE_ID</code>
                  </li>
                  <li>
                    <DiagDot ok={diag.fishaudio.memorySettingsHasApiKey} />
                    memory_settings.api_key
                  </li>
                  <li>
                    <DiagDot ok={diag.fishaudio.memorySettingsHasVoiceId} />
                    memory_settings.voice_id
                  </li>
                </ul>
              </section>

              <div style={buttonRow}>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  style={primaryButton(saving)}
                >
                  {saving ? "Salvando…" : "Salvar tudo"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({
  label,
  sub,
  available,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  available: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: "10px 12px",
        borderRadius: 10,
        background: active ? "var(--accent-soft)" : "var(--bg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        color: active ? "var(--accent)" : "var(--text-primary)",
        cursor: "pointer",
        textAlign: "left",
      }}
      title={available ? `Usar ${label}` : `${label} não está configurado`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        {available ? (
          <CheckCircle2 size={12} style={{ color: "#22c55e" }} />
        ) : (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--text-muted)",
              opacity: 0.5,
            }}
          />
        )}
      </div>
      <span style={{ fontSize: 11, opacity: 0.8 }}>{sub}</span>
    </button>
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

const providerRow: CSSProperties = {
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

const successBox: CSSProperties = {
  padding: "8px 10px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: 6,
  color: "var(--accent)",
  fontSize: 12,
};

const warningBox: CSSProperties = {
  padding: "8px 10px",
  background: "rgba(234,179,8,0.1)",
  border: "1px solid #eab308",
  borderRadius: 6,
  color: "#eab308",
  fontSize: 12,
};
