"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Download, RefreshCw, X } from "lucide-react";

interface AvailableSession {
  agentId: string;
  sessionId: string;
  sizeBytes: number;
  updatedAt: number;
  alreadyImported: boolean;
  threadId: string | null;
  messageCount: number;
}

interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  threads: Array<{
    agentId: string;
    sessionId: string;
    threadId: string;
    messagesAdded: number;
  }>;
  errors: Array<{ sessionId: string; error: string }>;
}

interface ImportOpenClawModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export function ImportOpenClawModal({ open, onClose, onImported }: ImportOpenClawModalProps) {
  const [sessions, setSessions] = useState<AvailableSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/import/openclaw");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: AvailableSession[] };
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
      setSummary(null);
      setSelected(new Set());
    }
  }, [open, load]);

  const handleImport = useCallback(
    async (force: boolean) => {
      setRunning(true);
      setError(null);
      try {
        const sessionIds = selected.size > 0 ? Array.from(selected) : undefined;
        const res = await fetch("/api/chat/import/openclaw", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionIds, force }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ImportSummary;
        setSummary(data);
        onImported();
        void load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [selected, onImported, load],
  );

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <header style={modalHeaderStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Importar sessions do OpenClaw
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              Cada arquivo JSONL em <code>~/.openclaw/agents/&lt;id&gt;/sessions</code> vira uma thread no chat.
            </p>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle}>
            <X size={18} />
          </button>
        </header>

        <div style={modalBodyStyle}>
          {error && <div style={errorBoxStyle}>⚠ {error}</div>}
          {summary && (
            <div style={summaryBoxStyle}>
              <strong>Resultado:</strong> {summary.imported} importadas · {summary.skipped} sem mudanças ·{" "}
              {summary.failed} falhas
              {summary.errors.length > 0 && (
                <ul style={{ margin: "8px 0 0 16px", fontSize: 12, color: "var(--danger, #ef4444)" }}>
                  {summary.errors.map((e) => (
                    <li key={e.sessionId}>
                      <code>{e.sessionId.slice(0, 16)}</code>: {e.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {loading ? (
            <div style={emptyStyle}>
              <RefreshCw size={20} />
              <span>Carregando sessions…</span>
            </div>
          ) : sessions.length === 0 ? (
            <div style={emptyStyle}>
              <span>Nenhuma session encontrada em OpenClaw.</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Verifique se <code>~/.openclaw/agents/&lt;id&gt;/sessions</code> existe.
              </span>
            </div>
          ) : (
            <div style={listStyle}>
              {sessions.map((s) => {
                const isSelected = selected.has(s.sessionId);
                return (
                  <label key={s.sessionId} style={rowStyle(isSelected)}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.sessionId);
                          else next.delete(s.sessionId);
                          return next;
                        });
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <code style={{ fontSize: 12, color: "var(--text-primary)" }}>
                          {s.sessionId.slice(0, 18)}…
                        </code>
                        <span style={pillStyle}>{s.agentId}</span>
                        {s.alreadyImported && <span style={importedPillStyle}>importada</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        {formatBytes(s.sizeBytes)} · atualizada {formatRel(s.updatedAt)}
                        {s.alreadyImported && ` · ${s.messageCount} mensagens`}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <footer style={modalFooterStyle}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {selected.size > 0 ? `${selected.size} selecionada(s)` : `Todas as ${sessions.length}`}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => handleImport(true)}
              disabled={running || sessions.length === 0}
              style={secondaryButtonStyle(running || sessions.length === 0)}
              title="Reconstrói as threads do zero"
            >
              Forçar reimport
            </button>
            <button
              type="button"
              onClick={() => handleImport(false)}
              disabled={running || sessions.length === 0}
              style={primaryButtonStyle(running || sessions.length === 0)}
            >
              <Download size={14} />
              {running ? "Importando…" : "Importar"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRel(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `há ${d}d`;
  return new Date(ms).toLocaleDateString("pt-BR");
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
  width: "min(720px, 95vw)",
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
  gap: 12,
};

const modalFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: 12,
  borderTop: "1px solid var(--border)",
  background: "var(--bg)",
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

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

function rowStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    background: selected ? "var(--accent-soft)" : "var(--bg)",
    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    cursor: "pointer",
  };
}

const emptyStyle: CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 13,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
};

const pillStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: "2px 6px",
  borderRadius: 4,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
};

const importedPillStyle: CSSProperties = {
  ...pillStyle,
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
  color: "var(--accent)",
};

const errorBoxStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--danger-soft, rgba(239,68,68,0.1))",
  border: "1px solid var(--danger, #ef4444)",
  borderRadius: 6,
  color: "var(--danger, #ef4444)",
  fontSize: 12,
};

const summaryBoxStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: 6,
  color: "var(--accent)",
  fontSize: 12,
};

function primaryButtonStyle(disabled?: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
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

function secondaryButtonStyle(disabled?: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 8,
    background: "var(--bg)",
    color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
    border: "1px solid var(--border)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
  };
}
