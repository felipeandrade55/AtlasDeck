"use client";

/**
 * Welcome wizard — 5-step setup that goes from a fresh clone to a fully
 * working AtlasDeck/OpenClaw with personality, model and Telegram all
 * wired. Polls /api/setup/status as source of truth so users can refresh,
 * crash, redeploy and resume right where they left off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { InstallStep } from "./steps/InstallStep";
import { AiProviderStep } from "./steps/AiProviderStep";
import { InterviewStep } from "./steps/InterviewStep";
import { TelegramStep } from "./steps/TelegramStep";
import { EmailStep } from "./steps/EmailStep";
import { DoneStep } from "./steps/DoneStep";

export type StepId = "install" | "ai" | "interview" | "telegram" | "email" | "done";

export interface SetupStatus {
  deployMode?: "native" | "coolify";
  setup: { step: StepId; completedAt: string | null };
  openclaw: { installed: boolean; binPath: string | null; version: string | null; workspace: string };
  interview: { done: boolean; hasIdentity: boolean; hasSoul: boolean; hasUser: boolean; complete: boolean };
  ai: {
    primaryModel: string | null;
    provider: string;
    configured: boolean;
    cloudKeys: Array<{ provider: string; hasKey: boolean; masked: string }>;
    ollama: { installed: boolean; running: boolean; modelsCount: number };
  };
  telegram: { connected: boolean; accountId: string; hasToken: boolean; hasChatId: boolean };
  email: { accountCount: number; skipped: boolean };
}

const STEPS: Array<{ id: StepId; label: string; description: string }> = [
  { id: "install", label: "Instalar", description: "Binário do OpenClaw" },
  { id: "ai", label: "Modelo de IA", description: "Local ou nuvem" },
  { id: "interview", label: "Personalidade", description: "Entrevista guiada" },
  { id: "telegram", label: "Telegram", description: "Conectar bot" },
  { id: "email", label: "E-mail", description: "Caixas IMAP (opcional)" },
  { id: "done", label: "Pronto", description: "Bora começar" },
];

interface Props {
  initialStatus: SetupStatus | null;
}

export function SetupStepper({ initialStatus }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [manualStep, setManualStep] = useState<StepId | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SetupStatus;
      setStatus(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!status) refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh, status]);

  const currentStep: StepId = manualStep ?? status?.setup.step ?? "install";
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);
  const progress = useMemo(() => buildProgress(status), [status]);

  if (!status && !error) {
    return (
      <div style={{ padding: "60px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--text-muted)" }}>
        <Loader2 size={18} className="spin" /> Carregando status do AtlasDeck…
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 24px 60px", maxWidth: 960, marginInline: "auto" }}>
      <Header />

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            background: "rgba(255,59,48,0.08)",
            border: "1px solid var(--danger, #FF3B30)",
            borderRadius: 10,
            color: "var(--danger, #FF3B30)",
            fontSize: 13,
          }}
        >
          Erro ao consultar status: {error}
        </div>
      )}

      <Stepper steps={STEPS} currentIndex={currentIndex} progress={progress} onJump={setManualStep} />

      <div
        style={{
          marginTop: 24,
          padding: 20,
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          minHeight: 240,
        }}
      >
        {status && currentStep === "install" && (
          <InstallStep
            status={status}
            onAdvance={() => {
              setManualStep(null);
              refresh();
            }}
          />
        )}
        {status && currentStep === "ai" && (
          <AiProviderStep
            status={status}
            onAdvance={() => {
              setManualStep(null);
              refresh();
            }}
          />
        )}
        {status && currentStep === "interview" && (
          <InterviewStep
            status={status}
            onAdvance={() => {
              setManualStep(null);
              refresh();
            }}
          />
        )}
        {status && currentStep === "telegram" && (
          <TelegramStep
            status={status}
            onAdvance={() => {
              setManualStep(null);
              refresh();
            }}
          />
        )}
        {status && currentStep === "email" && (
          <EmailStep
            status={status}
            onAdvance={() => {
              setManualStep(null);
              refresh();
            }}
          />
        )}
        {status && currentStep === "done" && <DoneStep status={status} />}
      </div>

      <p style={{ marginTop: 18, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
        Pode fechar e voltar a qualquer momento — o wizard retoma do passo onde você parou.
      </p>
    </div>
  );
}

function buildProgress(status: SetupStatus | null): Record<StepId, "done" | "current" | "pending"> {
  const out: Record<StepId, "done" | "current" | "pending"> = {
    install: "pending",
    ai: "pending",
    interview: "pending",
    telegram: "pending",
    email: "pending",
    done: "pending",
  };
  if (!status) return out;
  if (status.openclaw.installed) out.install = "done";
  if (status.ai.configured) out.ai = "done";
  if (status.interview.complete) out.interview = "done";
  if (status.telegram.connected) out.telegram = "done";
  if (status.email.accountCount > 0 || status.email.skipped) out.email = "done";
  if (status.setup.completedAt) out.done = "done";
  const current = status.setup.step;
  if (out[current] !== "done") out[current] = "current";
  return out;
}

function Header() {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 6,
        }}
      >
        Setup inicial
      </div>
      <h1
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: 28,
          fontWeight: 800,
          color: "var(--text-primary)",
          letterSpacing: "-1px",
          lineHeight: 1.15,
          marginBottom: 6,
        }}
      >
        Vamos preparar o seu OpenClaw em 6 passos
      </h1>
      <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 660 }}>
        Cada passo é detectado automaticamente — se você já tem algo configurado, o wizard pula adiante.
        Você pode revisitar qualquer etapa clicando nos números abaixo.
      </p>
    </div>
  );
}

interface StepperProps {
  steps: Array<{ id: StepId; label: string; description: string }>;
  currentIndex: number;
  progress: Record<StepId, "done" | "current" | "pending">;
  onJump: (step: StepId) => void;
}

function Stepper({ steps, currentIndex, progress, onJump }: StepperProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 8,
        overflowX: "auto",
      }}
    >
      {steps.map((step, idx) => {
        const state = progress[step.id];
        const isCurrent = idx === currentIndex;
        const isClickable = state === "done" || idx <= currentIndex;
        return (
          <div key={step.id} style={{ display: "flex", alignItems: "stretch", flex: 1, minWidth: 140 }}>
            <button
              type="button"
              onClick={() => isClickable && onJump(step.id)}
              disabled={!isClickable}
              style={{
                flex: 1,
                background: isCurrent ? "rgba(255,59,48,0.08)" : "transparent",
                border: "none",
                borderRadius: 8,
                padding: "10px 12px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: isClickable ? "pointer" : "default",
                textAlign: "left",
                color: isCurrent ? "var(--text-primary)" : "var(--text-secondary)",
                opacity: state === "pending" && !isCurrent ? 0.55 : 1,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background:
                    state === "done"
                      ? "var(--success, #32D74B)"
                      : isCurrent
                      ? "var(--accent)"
                      : "var(--border)",
                  color: state === "done" || isCurrent ? "var(--bg)" : "var(--text-muted)",
                  fontWeight: 700,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {state === "done" ? <Check size={14} /> : idx + 1}
              </span>
              <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                <strong style={{ fontSize: 13, fontWeight: 700 }}>{step.label}</strong>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{step.description}</span>
              </span>
            </button>
            {idx < steps.length - 1 && (
              <ChevronRight
                size={14}
                style={{ color: "var(--text-muted)", alignSelf: "center", marginInline: 2, flexShrink: 0 }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
