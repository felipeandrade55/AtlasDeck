"use client";

import { type CSSProperties } from "react";
import { Mic } from "lucide-react";

interface PushToTalkOverlayProps {
  visible: boolean;
  interim: string;
}

/**
 * Full-screen overlay shown while the user holds the push-to-talk
 * key. The big mic + live transcript makes it obvious the system is
 * capturing audio, and what it's hearing right now.
 */
export function PushToTalkOverlay({ visible, interim }: PushToTalkOverlayProps) {
  if (!visible) return null;
  return (
    <div style={backdropStyle}>
      <div style={cardStyle}>
        <div style={iconRingStyle}>
          <Mic size={36} />
        </div>
        <div style={titleStyle}>Ouvindo…</div>
        <div style={hintStyle}>Solte ESPAÇO para enviar</div>
        <div style={interimBoxStyle}>
          {interim || <span style={{ color: "var(--text-muted)" }}>diga seu comando</span>}
        </div>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 1500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const cardStyle: CSSProperties = {
  background: "var(--surface-elevated, var(--surface))",
  border: "2px solid var(--accent)",
  borderRadius: 16,
  padding: "24px 28px",
  minWidth: 360,
  maxWidth: "min(640px, 80vw)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
};

const iconRingStyle: CSSProperties = {
  width: 72,
  height: 72,
  borderRadius: 36,
  background: "var(--accent-soft)",
  border: "2px solid var(--accent)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  animation: "pulse 1.2s infinite",
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  letterSpacing: 0.3,
};

const interimBoxStyle: CSSProperties = {
  marginTop: 8,
  padding: "10px 14px",
  borderRadius: 10,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  width: "100%",
  minHeight: 44,
  fontSize: 14,
  color: "var(--text-primary)",
  textAlign: "center",
  lineHeight: 1.4,
};
