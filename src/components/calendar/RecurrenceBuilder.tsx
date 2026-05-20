"use client";

import { useEffect, useState } from "react";
import type { Recurrence, RecurrenceFreq } from "@/lib/calendar-types";

const FREQ_OPTIONS: { value: RecurrenceFreq | "none"; label: string }[] = [
  { value: "none", label: "Não repete" },
  { value: "daily", label: "Diariamente" },
  { value: "weekdays", label: "Dias úteis (seg-sex)" },
  { value: "weekly", label: "Semanalmente" },
  { value: "monthly", label: "Mensalmente" },
];

const WEEKDAYS_PT = ["D", "S", "T", "Q", "Q", "S", "S"];

interface Props {
  value: Recurrence | null;
  onChange: (value: Recurrence | null) => void;
}

export function RecurrenceBuilder({ value, onChange }: Props) {
  const [freq, setFreq] = useState<RecurrenceFreq | "none">(value?.freq ?? "none");
  const [interval, setInterval] = useState<number>(value?.interval ?? 1);
  const [byDay, setByDay] = useState<number[]>(value?.byDay ?? []);
  const [endMode, setEndMode] = useState<"never" | "until" | "count">(
    value?.until ? "until" : value?.count ? "count" : "never"
  );
  const [until, setUntil] = useState<string>(value?.until ? value.until.slice(0, 10) : "");
  const [count, setCount] = useState<number>(value?.count ?? 10);

  useEffect(() => {
    if (freq === "none") {
      onChange(null);
      return;
    }
    const rec: Recurrence = { freq: freq as RecurrenceFreq, interval };
    if (freq === "weekly" && byDay.length > 0) rec.byDay = byDay;
    if (endMode === "until" && until) rec.until = `${until}T23:59:59.000Z`;
    if (endMode === "count" && count > 0) rec.count = count;
    onChange(rec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, interval, byDay, endMode, until, count]);

  const toggleDay = (d: number) => {
    setByDay((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div>
        <select
          value={freq}
          onChange={(e) => setFreq(e.target.value as RecurrenceFreq | "none")}
          style={{
            width: "100%",
            padding: "0.65rem 0.85rem",
            backgroundColor: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-primary)",
            outline: "none",
            fontSize: "0.875rem",
          }}
        >
          {FREQ_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {freq !== "none" && freq !== "weekdays" && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>A cada</span>
          <input
            type="number"
            min={1}
            max={365}
            value={interval}
            onChange={(e) => setInterval(Math.max(1, Number(e.target.value)))}
            style={{
              width: "5rem",
              padding: "0.45rem 0.75rem",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
          <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            {freq === "daily" && (interval === 1 ? "dia" : "dias")}
            {freq === "weekly" && (interval === 1 ? "semana" : "semanas")}
            {freq === "monthly" && (interval === 1 ? "mês" : "meses")}
          </span>
        </div>
      )}

      {freq === "weekly" && (
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Em
          </div>
          <div style={{ display: "flex", gap: "0.375rem" }}>
            {WEEKDAYS_PT.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                style={{
                  flex: 1,
                  padding: "0.4rem 0",
                  borderRadius: "var(--radius-md)",
                  fontSize: "0.8rem",
                  fontWeight: byDay.includes(i) ? 700 : 500,
                  backgroundColor: byDay.includes(i) ? "var(--accent)" : "var(--surface-elevated)",
                  color: byDay.includes(i) ? "#000" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {freq !== "none" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>Termina</div>
          <div style={{ display: "flex", gap: "0.375rem" }}>
            {[
              { id: "never", label: "Nunca" },
              { id: "until", label: "Em data" },
              { id: "count", label: "Após X" },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setEndMode(opt.id as "never" | "until" | "count")}
                style={{
                  flex: 1,
                  padding: "0.4rem 0.6rem",
                  borderRadius: "var(--radius-md)",
                  fontSize: "0.78rem",
                  fontWeight: endMode === opt.id ? 600 : 500,
                  backgroundColor: endMode === opt.id ? "rgba(255,59,48,0.15)" : "var(--surface-elevated)",
                  color: endMode === opt.id ? "var(--accent)" : "var(--text-secondary)",
                  border: `1px solid ${endMode === opt.id ? "rgba(255,59,48,0.4)" : "var(--border)"}`,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {endMode === "until" && (
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              style={{
                padding: "0.5rem 0.75rem",
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
          )}

          {endMode === "count" && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="number"
                min={1}
                max={365}
                value={count}
                onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
                style={{
                  width: "5rem",
                  padding: "0.45rem 0.75rem",
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--text-primary)",
                  outline: "none",
                }}
              />
              <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>repetições</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
