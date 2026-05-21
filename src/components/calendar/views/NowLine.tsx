"use client";

import { useEffect, useState } from "react";

function minutesSinceMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function useNowTick(intervalMs = 60_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface NowLineProps {
  dayHeightPx: number;
  showLabel?: boolean;
}

export function NowLine({ dayHeightPx, showLabel = false }: NowLineProps) {
  const now = useNowTick();
  const topPx = (minutesSinceMidnight(now) / (24 * 60)) * dayHeightPx;
  const label = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: topPx,
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      {showLabel && (
        <div
          style={{
            position: "absolute",
            left: -54,
            top: -8,
            width: 48,
            textAlign: "right",
            fontSize: "0.65rem",
            fontWeight: 700,
            color: "var(--accent)",
            backgroundColor: "var(--surface)",
            paddingRight: 4,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: -4,
          top: -4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: "var(--accent)",
        }}
      />
      <div
        style={{
          height: 2,
          backgroundColor: "var(--accent)",
          boxShadow: "0 0 4px rgba(255,59,48,0.6)",
        }}
      />
    </div>
  );
}
