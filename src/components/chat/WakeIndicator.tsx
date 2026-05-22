"use client";

import { type CSSProperties } from "react";
import { Ear, EarOff } from "lucide-react";
import type { WakeState } from "./useWakeWord";

interface WakeIndicatorProps {
  state: WakeState;
  enabled: boolean;
  onToggle: () => void;
  phrases: string[];
  lastHeard?: string;
}

const STATE_LABEL: Record<WakeState, string> = {
  off: "Desligado",
  listening: "Ouvindo wake word",
  activated: "Comando recebido",
  error: "Erro no microfone",
};

const STATE_COLOR: Record<WakeState, string> = {
  off: "var(--text-muted)",
  listening: "#22c55e",
  activated: "var(--accent)",
  error: "var(--danger, #ef4444)",
};

export function WakeIndicator({ state, enabled, onToggle, phrases, lastHeard }: WakeIndicatorProps) {
  const color = STATE_COLOR[state];
  const Icon = enabled ? Ear : EarOff;
  const tooltip = lastHeard
    ? `Wake word: ${STATE_LABEL[state]} (${phrases.join(", ")})\núltimo ouvido: "${lastHeard}"`
    : `Wake word: ${STATE_LABEL[state]} (${phrases.join(", ")})`;

  return (
    <button
      type="button"
      onClick={onToggle}
      style={buttonStyle(enabled)}
      title={tooltip}
    >
      <span style={dotStyle(color, state === "listening")} />
      <Icon size={14} />
      <span style={{ fontSize: 11, fontWeight: 500 }}>
        {enabled ? phrases[0] : "Wake off"}
      </span>
      {enabled && lastHeard && (
        <span style={{ fontSize: 10, color: "var(--text-muted)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          👂 {lastHeard.length > 30 ? `…${lastHeard.slice(-28)}` : lastHeard}
        </span>
      )}
    </button>
  );
}

function buttonStyle(enabled: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 8,
    background: enabled ? "var(--accent-soft)" : "var(--bg)",
    border: `1px solid ${enabled ? "var(--accent)" : "var(--border)"}`,
    color: enabled ? "var(--accent)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 12,
  };
}

function dotStyle(color: string, pulsing: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: 4,
    background: color,
    animation: pulsing ? "pulse 1.6s infinite" : undefined,
  };
}
