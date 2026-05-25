"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, PlayCircle, RotateCcw, Terminal } from "lucide-react";
import type { SetupStatus } from "../SetupStepper";

interface LogEntry {
  kind: "stdout" | "stderr" | "info" | "error";
  line: string;
}

interface Props {
  status: SetupStatus;
  onAdvance: () => void;
}

export function InstallStep({ status, onAdvance }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [doneInfo, setDoneInfo] = useState<{ version: string; binPath: string; installedTo: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const installed = status.openclaw.installed;

  useEffect(() => {
    if (!logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  async function runInstall(force = false) {
    setRunning(true);
    setErrorMsg(null);
    setDoneInfo(null);
    setLogs([]);

    try {
      const res = await fetch(`/api/setup/install${force ? "?force=1" : ""}`, {
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
                setDoneInfo(parsed as { version: string; binPath: string; installedTo: string });
              } else if (currentEvent === "error") {
                setErrorMsg(parsed.message ?? "Erro desconhecido");
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      onAdvance();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Instalar o OpenClaw
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          Vamos rodar <code>npm install -g openclaw</code>. Se faltarem permissões para escrever no prefixo
          global do npm, o instalador cai automaticamente para <code>~/.openclaw-bin</code> — nada exige sudo.
        </p>
      </div>

      <StatusBanner status={status} doneInfo={doneInfo} />

      {errorMsg && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(255,59,48,0.08)",
            border: "1px solid var(--danger, #FF3B30)",
            borderRadius: 10,
            color: "var(--danger, #FF3B30)",
            fontSize: 13,
          }}
        >
          {errorMsg}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {!installed && !running && (
          <button type="button" onClick={() => runInstall(false)} style={primaryBtn}>
            <PlayCircle size={15} /> Instalar agora
          </button>
        )}
        {installed && !running && (
          <>
            <button type="button" onClick={onAdvance} style={primaryBtn}>
              Avançar pro próximo passo →
            </button>
            <button type="button" onClick={() => runInstall(true)} style={ghostBtn}>
              <RotateCcw size={14} /> Reinstalar
            </button>
          </>
        )}
        {running && (
          <button type="button" disabled style={primaryBtn}>
            <Loader2 size={15} className="spin" /> Instalando…
          </button>
        )}
      </div>

      {(logs.length > 0 || running) && (
        <div
          ref={logBoxRef}
          style={{
            marginTop: 4,
            padding: 12,
            background: "#0b0b0e",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
            fontSize: 11.5,
            lineHeight: 1.55,
            maxHeight: 280,
            overflowY: "auto",
            color: "#e4e4e7",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#9ca3af", marginBottom: 6 }}>
            <Terminal size={12} /> install log
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
  );
}

function StatusBanner({
  status,
  doneInfo,
}: {
  status: SetupStatus;
  doneInfo: { version: string; binPath: string; installedTo: string } | null;
}) {
  const installed = status.openclaw.installed || !!doneInfo;
  const version = doneInfo?.version ?? status.openclaw.version;
  const binPath = doneInfo?.binPath ?? status.openclaw.binPath;
  if (!installed) {
    return (
      <div
        style={{
          padding: "10px 14px",
          background: "rgba(168,85,247,0.08)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          fontSize: 13,
          color: "var(--text-secondary)",
        }}
      >
        OpenClaw ainda não detectado no PATH. Clique em <strong>Instalar agora</strong> para começar.
      </div>
    );
  }
  return (
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
        <strong style={{ color: "var(--text-primary)" }}>OpenClaw pronto</strong>
        <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 2 }}>
          {binPath} {version ? `(v${version})` : ""}
        </div>
      </div>
    </div>
  );
}

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
