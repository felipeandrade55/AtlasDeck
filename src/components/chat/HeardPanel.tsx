"use client";

import { type CSSProperties } from "react";

export interface HeardEntry {
  at: number;
  text: string;
  matched: boolean;
}

interface HeardPanelProps {
  entries: HeardEntry[];
  enabled: boolean;
}

/**
 * Floating diagnostic panel that shows the latest final transcripts the
 * wake-word recogniser captured. Helps the user understand *why* the
 * wake never fires (almost always because pt-BR ASR transcribes the
 * trigger word as something unexpected).
 *
 * Entries fade out after 30s of inactivity so the panel stays calm.
 */
export function HeardPanel({ entries, enabled }: HeardPanelProps) {
  const fresh = entries.filter((e) => Date.now() - e.at < 30_000);
  if (!enabled || fresh.length === 0) return null;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>👂 Web Speech ouviu</div>
      <ul style={listStyle}>
        {fresh.slice(-5).reverse().map((entry) => (
          <li key={entry.at} style={itemStyle(entry.matched)}>
            <span style={dotStyle(entry.matched)} />
            <span style={textStyle}>{entry.text}</span>
            <span style={timeStyle}>{relativeTime(entry.at)}</span>
          </li>
        ))}
      </ul>
      <div style={hintStyle}>
        ✅ verde = match · ⚪ cinza = não-match · diga “Atlas” para acionar
      </div>
    </div>
  );
}

function relativeTime(at: number): string {
  const diff = Math.floor((Date.now() - at) / 1000);
  if (diff < 1) return "agora";
  if (diff < 60) return `${diff}s atrás`;
  return `${Math.floor(diff / 60)}m`;
}

const containerStyle: CSSProperties = {
  position: "fixed",
  bottom: 96,
  right: 24,
  width: 320,
  maxWidth: "calc(100vw - 48px)",
  padding: "10px 12px",
  background: "var(--surface-elevated, var(--surface))",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  zIndex: 60,
  fontSize: 12,
  pointerEvents: "auto",
};

const headerStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: "var(--text-secondary)",
  marginBottom: 6,
  letterSpacing: 0.3,
  textTransform: "uppercase",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

function itemStyle(matched: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 6px",
    borderRadius: 6,
    background: matched ? "var(--accent-soft)" : "var(--bg)",
    border: `1px solid ${matched ? "var(--accent)" : "var(--border)"}`,
    color: "var(--text-primary)",
  };
}

function dotStyle(matched: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
    background: matched ? "#22c55e" : "var(--text-muted)",
  };
}

const textStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
};

const timeStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const hintStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: "1px solid var(--border)",
  fontSize: 10,
  color: "var(--text-muted)",
  lineHeight: 1.4,
};
