"use client";

import { useEffect, useState } from "react";
import { X, Copy, Check, Terminal, ShieldAlert, Loader2 } from "lucide-react";

export function AddVpsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [script, setScript] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/vps/install")
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setScript(t))
      .catch(() => setScript(null));
  }, []);

  const handleCopy = async () => {
    if (!script) return;
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Não foi possível copiar — copie manualmente.");
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Informe um nome para o VPS.");
      return;
    }
    if (token.trim().length < 16) {
      setError("Cole o token gerado pelo script no VPS.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/vps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao salvar");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl overflow-hidden max-h-[90vh] flex flex-col"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
            Adicionar VPS
          </h2>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* Step 1: name */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--text-primary)" }}>
              1. Nome do VPS
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: vps-frankfurt-1"
              className="w-full text-sm rounded-lg px-3 py-2"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)", outline: "none" }}
            />
          </div>

          {/* Step 2: copy script + instructions */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--text-primary)" }}>
              2. Instale o agente no VPS
            </label>
            <button
              onClick={handleCopy}
              disabled={!script}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg w-full justify-center"
              style={{
                backgroundColor: copied ? "color-mix(in srgb, var(--success) 15%, transparent)" : "var(--card-elevated)",
                color: copied ? "var(--success)" : "var(--accent)",
                border: `1px solid ${copied ? "color-mix(in srgb, var(--success) 30%, transparent)" : "var(--border)"}`,
                cursor: script ? "pointer" : "not-allowed",
              }}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Script copiado!" : "Copiar script de instalação"}
            </button>

            <ol className="mt-3 space-y-1.5 text-xs leading-relaxed list-decimal pl-4" style={{ color: "var(--text-secondary)" }}>
              <li>No seu VPS Ubuntu, cole o script num arquivo: <code style={codeStyle}>nano install.sh</code></li>
              <li>Execute como root: <code style={codeStyle}>sudo bash install.sh</code></li>
              <li>Aguarde terminar — o script mostra um <strong>TOKEN</strong> no final.</li>
              <li>Copie o token e cole no campo abaixo.</li>
            </ol>

            <div className="flex items-start gap-2 mt-3 p-2.5 rounded-lg text-[11px]" style={{ backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)", color: "var(--warning)" }}>
              <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                O agente roda como root (necessário para ler processos, systemd e Docker). Use sempre conexão HTTPS para o AtlasDeck.
              </span>
            </div>
          </div>

          {/* Step 3: paste token */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--text-primary)" }}>
              3. Cole o token gerado
            </label>
            <div className="relative">
              <Terminal className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--text-muted)" }} />
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="cole aqui o token exibido no terminal do VPS"
                className="w-full text-sm rounded-lg pl-9 pr-3 py-2 font-mono"
                style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)", outline: "none" }}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "var(--error)" }}>
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--border)" }}>
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg" style={{ color: "var(--text-secondary)" }}>
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg"
            style={{ backgroundColor: "var(--accent)", color: "white", opacity: saving ? 0.7 : 1 }}
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Salvar e iniciar
          </button>
        </div>
      </div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  backgroundColor: "var(--card-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  padding: "1px 5px",
  fontFamily: "monospace",
  fontSize: "11px",
  color: "var(--text-primary)",
};
