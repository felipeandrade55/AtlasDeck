"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, CheckCircle2, Cpu, Loader2, MessageCircle, Package } from "lucide-react";
import type { SetupStatus } from "../SetupStepper";

interface Props {
  status: SetupStatus;
}

export function DoneStep({ status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/complete", { method: "POST" });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <CheckCircle2 size={42} style={{ color: "var(--success, #32D74B)", margin: "0 auto 8px" }} />
        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4 }}>
          Tudo pronto
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
          Seu AtlasDeck está configurado. Próximas mensagens no Telegram já vão pro agente.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <Recap icon={Package} label="OpenClaw" value={status.openclaw.version ? `v${status.openclaw.version}` : "instalado"} />
        <Recap icon={Cpu} label="Modelo" value={status.ai.primaryModel ?? "—"} />
        <Recap icon={Bot} label="Persona" value={status.interview.complete ? "configurada" : "pendente"} />
        <Recap
          icon={MessageCircle}
          label="Telegram"
          value={status.telegram.connected ? "conectado" : "—"}
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

      <div style={{ display: "flex", justifyContent: "center" }}>
        <button
          type="button"
          onClick={finish}
          disabled={busy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "11px 22px",
            borderRadius: 10,
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? <Loader2 size={15} className="spin" /> : null}
          Ir pro dashboard <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

function Recap({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Icon size={16} style={{ color: "var(--accent)" }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-primary)",
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
