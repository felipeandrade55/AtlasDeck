"use client";

import { useMemo } from "react";
import { addDays, isSameDay, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import type { ExpandedEvent, CalendarBlock } from "@/lib/calendar-types";

const WEEKDAYS_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

interface Props {
  focusDate: Date;
  events: ExpandedEvent[];
  blocks: CalendarBlock[];
  onCreateAt: (start: Date, end: Date) => void;
  onSelectEvent: (eventId: string, occurrenceDate?: string | null, completed?: boolean) => void;
  onDayClick?: (date: Date) => void;
}

export function MonthView({ focusDate, events, blocks, onCreateAt, onSelectEvent, onDayClick }: Props) {
  const days = useMemo(() => {
    const monthStart = startOfMonth(focusDate);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [focusDate]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, ExpandedEvent[]>();
    for (const ev of events) {
      const d = new Date(ev.start_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const blocksByDay = useMemo(() => {
    const map = new Map<string, CalendarBlock[]>();
    for (const b of blocks) {
      const start = new Date(b.start_at);
      const end = new Date(b.end_at);
      const d = new Date(start);
      d.setHours(0, 0, 0, 0);
      while (d <= end) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const list = map.get(key) ?? [];
        list.push(b);
        map.set(key, list);
        d.setDate(d.getDate() + 1);
      }
    }
    return map;
  }, [blocks]);

  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {WEEKDAYS_PT.map((d) => (
          <div
            key={d}
            style={{
              padding: "0.5rem",
              textAlign: "center",
              fontSize: "0.7rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              fontWeight: 600,
              borderLeft: "1px solid var(--border)",
            }}
          >
            {d}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gridAutoRows: "minmax(110px, 1fr)" }}>
        {days.map((d, i) => {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const dayEvents = eventsByDay.get(key) ?? [];
          const dayBlocks = blocksByDay.get(key) ?? [];
          const today = isSameDay(d, new Date());
          const inMonth = isSameMonth(d, focusDate);
          return (
            <div
              key={i}
              onDoubleClick={() => {
                const start = new Date(d);
                start.setHours(9, 0, 0, 0);
                const end = new Date(d);
                end.setHours(10, 0, 0, 0);
                onCreateAt(start, end);
              }}
              onClick={() => onDayClick?.(d)}
              style={{
                borderTop: "1px solid var(--border)",
                borderLeft: "1px solid var(--border)",
                padding: "0.4rem",
                opacity: inMonth ? 1 : 0.45,
                backgroundColor: today ? "rgba(255,59,48,0.06)" : "transparent",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: today ? 700 : 600,
                  color: today ? "var(--accent)" : "var(--text-primary)",
                }}
              >
                {d.getDate()}
              </div>
              {dayBlocks.length > 0 && (
                <div
                  style={{
                    fontSize: "0.65rem",
                    color: "var(--text-secondary)",
                    background:
                      "repeating-linear-gradient(45deg, var(--surface-elevated) 0 6px, var(--surface-hover) 6px 12px)",
                    padding: "2px 4px",
                    borderRadius: 4,
                  }}
                >
                  🚫 {dayBlocks.length} bloqueio{dayBlocks.length > 1 ? "s" : ""}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
                {dayEvents.slice(0, 3).map((ev) => {
                  const completed = !!ev.completed_at;
                  return (
                    <button
                      key={`${ev.id}-${ev.occurrence_date ?? ev.start_at}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(ev.id, ev.occurrence_date, completed);
                      }}
                      style={{
                        textAlign: "left",
                        fontSize: "0.65rem",
                        padding: "2px 6px",
                        borderRadius: 4,
                        borderLeft: `3px solid ${completed ? "var(--positive)" : ev.color || "#FF3B30"}`,
                        backgroundColor: completed ? "var(--positive-soft)" : `${ev.color || "#FF3B30"}22`,
                        color: completed ? "var(--positive)" : "var(--text-primary)",
                        border: "none",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        textDecoration: completed ? "line-through" : "none",
                      }}
                    >
                      {ev.all_day ? "" : new Date(ev.start_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}{" "}
                      {ev.title}
                    </button>
                  );
                })}
                {dayEvents.length > 3 && (
                  <div style={{ fontSize: "0.6rem", color: "var(--text-muted)" }}>+{dayEvents.length - 3} mais</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
