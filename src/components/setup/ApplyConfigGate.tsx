"use client";

/**
 * Tela de "Aplicar configuração" — a barra de progresso que o usuário vê ao
 * fim da escolha de modelo + entrevista, ANTES de conectar o Telegram. Dispara
 * POST /api/setup/apply (sanea config → reinicia gateway → espera ficar pronto)
 * e, quando tudo sobe, chama onReady. Pensada para leigos: nunca trava — se o
 * gateway demorar, oferece "tentar de novo" ou "continuar mesmo assim" (o
 * self-heal segue em background).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

interface ApplyStep {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

const PHASES = [
  "Saneando a configuração",
  "Aplicando o modelo de IA escolhido",
  "Reiniciando o gateway do OpenClaw",
  "Subindo o seu assistente",
  "Verificando a saúde do sistema",
];

export function ApplyConfigGate({ onReady }: { onReady: () => void }) {
  const [progress, setProgress] = useState(8);
  const [done, setDone] = useState<"ok" | "warn" | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const started = useRef(false);

  const run = useCallback(async () => {
    setDone(null);
    setDetail(null);
    setProgress(8);
    try {
      const res = await fetch("/api/setup/apply", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; steps?: ApplyStep[] };
      setProgress(100);
      if (json.ok) {
        setDone("ok");
        setTimeout(onReady, 900);
      } else {
        setDone("warn");
        const failed = (json.steps || []).find((s) => !s.ok);
        setDetail(failed?.detail || "O gateway demorou para responder.");
      }
    } catch (e) {
      setProgress(100);
      setDone("warn");
      setDetail(e instanceof Error ? e.message : String(e));
    }
  }, [onReady]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, [run]);

  // Anima a barra rumo a ~92% enquanto a requisição está em voo.
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => {
      setProgress((p) => (p < 92 ? p + Math.max(1, Math.round((94 - p) / 14)) : p));
    }, 350);
    return () => clearInterval(t);
  }, [done]);

  const phaseIdx = Math.min(PHASES.length - 1, Math.floor((progress / 100) * PHASES.length));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          {done === "ok" ? "Tudo pronto!" : "Preparando o seu assistente"}
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {done === "ok"
            ? "Configuração aplicada e gateway no ar. Vamos conectar o Telegram."
            : "Estamos aplicando tudo que você escolheu e ligando o seu assistente. Leva alguns segundos."}
        </p>
      </div>

      {/* Barra de progresso */}
      <div
        style={{
          height: 10,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${progress}%`,
            background: done === "warn" ? "var(--warning, #FFD60A)" : "var(--accent)",
            borderRadius: 999,
            transition: "width 0.35s ease",
          }}
        />
      </div>

      {/* Estado atual */}
      {!done && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-secondary)", fontSize: 13 }}>
          <Loader2 size={15} className="spin" /> {PHASES[phaseIdx]}…
        </div>
      )}

      {done === "ok" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--success, #32D74B)", fontSize: 13.5 }}>
          <CheckCircle2 size={16} /> Assistente no ar — abrindo o passo do Telegram…
        </div>
      )}

      {done === "warn" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 14px",
              background: "rgba(255,214,10,0.08)",
              border: "1px solid var(--warning, #FFD60A)",
              borderRadius: 10,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            <AlertTriangle size={16} style={{ color: "var(--warning, #FFD60A)", flexShrink: 0, marginTop: 1 }} />
            <span>
              O gateway ainda está subindo{detail ? ` (${detail})` : ""}. Ele tenta se recuperar sozinho —
              você pode tentar de novo ou seguir; dá pra reiniciar depois em Configurações.
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={primaryBtn} onClick={run}>
              Tentar novamente
            </button>
            <button type="button" style={ghostBtn} onClick={onReady}>
              Continuar mesmo assim →
            </button>
          </div>
        </div>
      )}
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
