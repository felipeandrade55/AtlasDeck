"use client";

import { useMemo } from "react";
import { addMonths, isSameDay, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["S", "T", "Q", "Q", "S", "S", "D"];
const MONTHS_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

interface Props {
  focusDate: Date;
  onPick: (date: Date) => void;
}

export function MiniMonthPicker({ focusDate, onPick }: Props) {
  const days = useMemo(() => {
    const monthStart = startOfMonth(focusDate);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [focusDate]);

  const today = new Date();

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <button
          type="button"
          onClick={() => onPick(addMonths(focusDate, -1))}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: 4 }}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
          {MONTHS_PT[focusDate.getMonth()]} {focusDate.getFullYear()}
        </div>
        <button
          type="button"
          onClick={() => onPick(addMonths(focusDate, 1))}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: 4 }}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            style={{
              fontSize: "0.65rem",
              color: "var(--text-muted)",
              textAlign: "center",
              padding: "2px 0",
              fontWeight: 600,
            }}
          >
            {d}
          </div>
        ))}
        {days.map((d, i) => {
          const inMonth = isSameMonth(d, focusDate);
          const isToday = isSameDay(d, today);
          const isFocus = isSameDay(d, focusDate);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(d)}
              style={{
                fontSize: "0.75rem",
                padding: "4px 0",
                borderRadius: "50%",
                aspectRatio: "1 / 1",
                background: isFocus ? "var(--accent)" : isToday ? "rgba(255,59,48,0.15)" : "transparent",
                color: isFocus
                  ? "#000"
                  : isToday
                    ? "var(--accent)"
                    : inMonth
                      ? "var(--text-primary)"
                      : "var(--text-muted)",
                border: "none",
                cursor: "pointer",
                fontWeight: isFocus || isToday ? 700 : 500,
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
