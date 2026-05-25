"use client";

/**
 * Destructive "Reinicializar OpenClaw" panel.
 *
 * Two-step confirmation:
 *   1. The panel itself shows the danger zone + a "Reinicializar" button.
 *   2. Clicking opens a modal that lists what will be deleted, offers an
 *      optional backup (checked by default), and requires the user to
 *      type "RESETAR" before the destroy button enables.
 *
 * The reset call streams progress as SSE so the user sees the npm
 * uninstall + rm output live. On success we redirect to /welcome so the
 * standard SetupGuard / install wizard takes over.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Loader2, RotateCcw, Terminal, X } from "lucide-react";

interface LogEntry {
  kind: "info" | "stdout" | "stderr" | "error";
  line: string;
}

export function ResetOpenClawPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-xl p-4 md:p-6"
      style={{
        background: "rgba(255, 59, 48, 0.04)",
        border: "1px solid var(--danger, #FF3B30)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div
          style={{
            flexShrink: 0,
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "rgba(255, 59, 48, 0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AlertTriangle size={18} style={{ color: "var(--danger, #FF3B30)" }} />
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
            Reinicializar OpenClaw
          </h3>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            Remove a instalação atual (binário + workspaces + chaves de provider + conexão Telegram)
            e dispara o wizard de instalação do zero. Útil quando uma configuração ficou inconsistente
            ou você quer recomeçar limpo. As suas memórias extraídas (data/memories.db) são preservadas.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              marginTop: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderRadius: 8,
              background: "var(--danger, #FF3B30)",
              color: "white",
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <RotateCcw size={13} /> Reinicializar agora
          </button>
        </div>
      </div>

      {open && <ResetModal onClose={() => setOpen(false)} />}
    </div>
  );
}

function ResetModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [backup, setBackup] = useState(true);
  const [confirmText, setConfirmText] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [doneInfo, setDoneInfo] = useState<{ nextStep: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const canConfirm = confirmText.trim().toUpperCase() === "RESETAR";

  async function performReset() {
    if (!canConfirm) return;
    setRunning(true);
    setLogs([]);
    setErrorMsg(null);
    setDoneInfo(null);
    try {
      const res = await fetch(`/api/setup/reset?backup=${backup ? "1" : "0"}`, {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "log";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              if (currentEvent === "log") {
                setLogs((prev) => [...prev, parsed as LogEntry]);
              } else if (currentEvent === "done") {
                setDoneInfo(parsed);
              } else if (currentEvent === "error") {
                setErrorMsg(parsed.message ?? "Erro desconhecido");
              }
            } catch {
              // ignore malformed
            }
          }
        }
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function finishAndGo() {
    onClose();
    router.push(doneInfo?.nextStep ?? "/welcome");
  }

  return (
    <div
      onClick={running ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AlertTriangle size={20} style={{ color: "var(--danger, #FF3B30)" }} />
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
              Reinicializar OpenClaw
            </h2>
          </div>
          {!running && (
            <button
              type="button"
              onClick={onClose}
              style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {!doneInfo && (
          <>
            <div
              style={{
                padding: "12px 14px",
                background: "rgba(255, 59, 48, 0.08)",
                border: "1px solid rgba(255, 59, 48, 0.4)",
                borderRadius: 10,
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: "var(--text-primary)" }}>Esta ação é destrutiva e não dá pra desfazer pela interface.</strong>
              <br />
              Vamos remover:
              <ul style={{ marginTop: 8, paddingLeft: 20, color: "var(--text-secondary)" }}>
                <li>O pacote npm global <code>openclaw</code></li>
                <li><code>~/.openclaw</code> (workspaces, agents, openclaw.json)</li>
                <li><code>~/.openclaw-bin</code> (fallback de prefixo local, se existir)</li>
                <li>Chaves de provider cloud (<code>data/provider-keys.json</code>)</li>
                <li>Configuração local do Telegram (<code>data/telegram-accounts.json</code>)</li>
                <li>Cores/emoji dos agents (<code>data/agents-ui.json</code>)</li>
                <li>Estado do wizard (volta pro passo &quot;Instalar&quot;)</li>
              </ul>
              <span style={{ display: "block", marginTop: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
                <strong>Não removido:</strong> suas memórias extraídas (<code>data/memories.db</code>),
                histórico de chats, logs, login do AtlasDeck e .env.
              </span>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 12px",
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={backup}
                disabled={running}
                onChange={(e) => setBackup(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <div>
                <strong style={{ fontSize: 13.5, color: "var(--text-primary)", display: "block" }}>
                  Fazer backup antes (recomendado)
                </strong>
                <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  Empacota <code>data/</code>, <code>~/.openclaw</code> e <code>.env</code> num tarball
                  antes de remover. Se desmarcar, a remoção é direta — sem rede de segurança.
                </span>
              </div>
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Digite <strong style={{ color: "var(--danger, #FF3B30)" }}>RESETAR</strong> pra confirmar
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={running}
                autoFocus
                style={{
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                }}
                placeholder="RESETAR"
                autoComplete="off"
              />
            </div>

            {errorMsg && (
              <div
                style={{
                  padding: "10px 14px",
                  background: "rgba(255, 59, 48, 0.08)",
                  border: "1px solid var(--danger, #FF3B30)",
                  borderRadius: 10,
                  color: "var(--danger, #FF3B30)",
                  fontSize: 13,
                }}
              >
                {errorMsg}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {!running && (
                <button type="button" onClick={onClose} style={ghostBtn}>
                  Cancelar
                </button>
              )}
              <button
                type="button"
                onClick={performReset}
                disabled={!canConfirm || running}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 16px",
                  borderRadius: 8,
                  background: canConfirm ? "var(--danger, #FF3B30)" : "var(--border)",
                  color: "white",
                  border: "none",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: canConfirm && !running ? "pointer" : "not-allowed",
                  opacity: canConfirm ? 1 : 0.6,
                }}
              >
                {running ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                {running ? "Reinicializando…" : "Confirmar reinstalação"}
              </button>
            </div>
          </>
        )}

        {doneInfo && (
          <div
            style={{
              padding: "12px 14px",
              background: "rgba(50, 215, 75, 0.08)",
              border: "1px solid var(--success, #32D74B)",
              borderRadius: 10,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ flex: 1 }}>
              <strong style={{ color: "var(--text-primary)" }}>Pronto.</strong> OpenClaw foi removido e o estado do wizard zerado.
              Vamos te mandar pro <code>/welcome</code> pra reinstalação.
            </div>
            <button type="button" onClick={finishAndGo} style={{ ...primaryBtn, background: "var(--success, #32D74B)" }}>
              Ir agora <ArrowRight size={14} />
            </button>
          </div>
        )}

        {(logs.length > 0 || running) && (
          <div
            ref={logBoxRef}
            style={{
              padding: 12,
              background: "#0b0b0e",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
              fontSize: 11.5,
              lineHeight: 1.55,
              maxHeight: 240,
              overflowY: "auto",
              color: "#e4e4e7",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#9ca3af", marginBottom: 6 }}>
              <Terminal size={12} /> reset log
            </div>
            {logs.map((entry, i) => (
              <div
                key={i}
                style={{
                  color:
                    entry.kind === "stderr"
                      ? "#fbbf24"
                      : entry.kind === "error"
                      ? "#fca5a5"
                      : entry.kind === "info"
                      ? "#93c5fd"
                      : "#e4e4e7",
                }}
              >
                {entry.line}
              </div>
            ))}
            {running && <div style={{ color: "#9ca3af" }}>…</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderRadius: 8,
  color: "white",
  border: "none",
  fontSize: 13,
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
