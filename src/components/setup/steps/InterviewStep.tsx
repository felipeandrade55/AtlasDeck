"use client";

import { CheckCircle2 } from "lucide-react";
import type { SetupStatus } from "../SetupStepper";
import { OnboardingWizard } from "@/components/memory/OnboardingWizard";

interface Props {
  status: SetupStatus;
  onAdvance: () => void;
}

export function InterviewStep({ status, onAdvance }: Props) {
  const complete = status.interview.complete;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Personalizar o agente
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          A entrevista guiada (em PT-BR) gera <code>IDENTITY.md</code>, <code>SOUL.md</code> e
          <code> USER.md</code> no workspace do OpenClaw. Você revisa e edita antes de salvar.
        </p>
      </div>

      {complete && (
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
            <strong>Persona já configurada.</strong> Pode refazer abaixo ou avançar pro Telegram.
          </div>
          <button
            type="button"
            onClick={onAdvance}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Avançar →
          </button>
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 12,
          background: "var(--bg)",
        }}
      >
        <OnboardingWizard workspace={status.openclaw.workspace} />
      </div>
    </div>
  );
}
