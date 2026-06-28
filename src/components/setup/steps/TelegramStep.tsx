"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, Loader2, MessageCircle, Smartphone } from "lucide-react";
import type { SetupStatus } from "../SetupStepper";
import { ApplyConfigGate } from "../ApplyConfigGate";

interface Props {
  status: SetupStatus;
  onAdvance: () => void;
}

interface PairingState {
  nonce: string;
  expiresAt: number;
  botUsername: string;
  botFirstName: string;
  deepLink: string;
  qrSvg: string;
}

interface PairedResult {
  accountId: string;
  botUsername: string;
  chatId: string;
  firstName: string | null;
}

export function TelegramStep({ status, onAdvance }: Props) {
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState<"start" | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<PairedResult | null>(null);
  // Antes de mostrar o pareamento, rodamos a tela de "Aplicar configuração"
  // (barra de progresso): aplica o modelo escolhido + sobe o gateway. Pulamos
  // se o Telegram já estiver conectado (retomada de wizard).
  const [applied, setApplied] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      pollAbort.current?.abort();
    };
  }, []);

  async function startPairing() {
    setBusy("start");
    setError(null);
    setPaired(null);
    setPairing(null);
    try {
      const res = await fetch("/api/setup/telegram/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setPairing(json as PairingState);
      pollLoop(json.nonce);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pollLoop(nonce: string) {
    pollAbort.current?.abort();
    const controller = new AbortController();
    pollAbort.current = controller;
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`/api/setup/telegram/poll?nonce=${encodeURIComponent(nonce)}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return;
        if (json.status === "paired") {
          setPaired(json as PairedResult);
          setTimeout(onAdvance, 1200);
          return;
        }
        if (json.status === "expired") {
          setError("O QR code expirou. Gere um novo.");
          setPairing(null);
          return;
        }
        if (json.status === "error") {
          setError(json.error ?? "Erro no polling");
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        // network blip — wait briefly and retry
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // Gate de "Aplicar configuração" (barra de progresso) — só na primeira vez,
  // e apenas quando ainda não há Telegram conectado.
  if (!applied && !status.telegram.connected) {
    return <ApplyConfigGate onReady={() => setApplied(true)} />;
  }

  if (status.telegram.connected && !paired) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Telegram já conectado</h2>
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
          <span style={{ flex: 1 }}>
            Bot configurado na conta <code>{status.telegram.accountId}</code>.
          </span>
          <button type="button" onClick={onAdvance} style={primaryBtn}>
            Avançar →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Conectar Telegram
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          1. Abra o{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            @BotFather
          </a>{" "}
          no Telegram, mande <code>/newbot</code> e copie o token. <br />
          2. Cole abaixo. A gente valida, gera um QR code e detecta o seu chat sozinho quando você abrir o bot.
        </p>
      </div>

      {paired && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(50,215,75,0.1)",
            border: "1px solid var(--success, #32D74B)",
            borderRadius: 10,
            fontSize: 13.5,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <CheckCircle2 size={18} style={{ color: "var(--success, #32D74B)" }} />
          <div>
            <strong>Conectado!</strong> Mandamos uma mensagem de teste pro seu chat ({paired.chatId}). Avançando…
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Bot token</label>
        <input
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456789:ABC-DEFghijkl..."
          style={inputStyle}
          autoComplete="off"
          disabled={!!pairing}
        />
      </div>

      {error && (
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
          {error}
        </div>
      )}

      {!pairing && (
        <div>
          <button
            type="button"
            onClick={startPairing}
            disabled={!botToken.trim() || busy === "start"}
            style={primaryBtn}
          >
            {busy === "start" ? <Loader2 size={14} className="spin" /> : <MessageCircle size={14} />} Validar e gerar QR
          </button>
        </div>
      )}

      {pairing && !paired && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 240px) 1fr",
            gap: 18,
            alignItems: "center",
            padding: 16,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 12,
          }}
        >
          <div
            style={{
              background: "white",
              padding: 12,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 12 }}>
              <Smartphone size={14} /> No celular, abra o bot e mande <code>/start</code>
            </div>
            <strong style={{ fontSize: 15, color: "var(--text-primary)" }}>@{pairing.botUsername}</strong>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <a
                href={pairing.deepLink}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "6px 12px",
                  border: "1px solid var(--accent)",
                  borderRadius: 8,
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontSize: 12.5,
                }}
              >
                Abrir no Telegram
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(pairing.deepLink).catch(() => {})}
                style={{ ...ghostBtn, padding: "6px 10px" }}
                title="Copiar link"
              >
                <Copy size={12} /> Copiar
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11.5 }}>
              <Loader2 size={12} className="spin" /> Aguardando você abrir o bot…
            </div>
          </div>
        </div>
      )}
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
