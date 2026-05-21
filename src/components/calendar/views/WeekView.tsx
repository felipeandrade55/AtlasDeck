"use client";

import { useMemo, useRef, useState } from "react";
import { addDays, isSameDay, startOfWeek } from "date-fns";
import type { ExpandedEvent, CalendarBlock } from "@/lib/calendar-types";
import { HOURS, fmtHour, positionItemsInDay } from "./_utils";
import { NowLine } from "./NowLine";

const HOUR_HEIGHT_PX = 48;
const WEEKDAYS_PT = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

interface Props {
  focusDate: Date;
  events: ExpandedEvent[];
  blocks: CalendarBlock[];
  onCreateAt: (start: Date, end: Date) => void;
  onSelectEvent: (eventId: string) => void;
  onSelectBlock?: (blockId: string) => void;
}

export function WeekView({ focusDate, events, blocks, onCreateAt, onSelectEvent, onSelectBlock }: Props) {
  const weekStart = useMemo(() => startOfWeek(focusDate, { weekStartsOn: 1 }), [focusDate]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

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
          gridTemplateColumns: "60px repeat(7, 1fr)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div />
        {days.map((d) => {
          const today = isSameDay(d, new Date());
          return (
            <div
              key={d.toISOString()}
              style={{
                padding: "0.5rem",
                textAlign: "center",
                borderLeft: "1px solid var(--border)",
                backgroundColor: today ? "rgba(255,59,48,0.06)" : "var(--surface)",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
                {WEEKDAYS_PT[d.getDay() === 0 ? 6 : d.getDay() - 1]}
              </div>
              <div
                style={{
                  fontSize: "1.2rem",
                  fontWeight: 700,
                  color: today ? "var(--accent)" : "var(--text-primary)",
                  fontFamily: "var(--font-heading)",
                }}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          maxHeight: "calc(100vh - 260px)",
          overflowY: "auto",
        }}
      >
        <div>
          {HOURS.map((h) => (
            <div
              key={h}
              style={{
                height: HOUR_HEIGHT_PX,
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                textAlign: "right",
                paddingRight: 8,
                borderTop: "1px solid var(--border)",
                transform: "translateY(-8px)",
              }}
            >
              {fmtHour(h)}
            </div>
          ))}
        </div>

        {days.map((day) => (
          <DayColumn
            key={day.toISOString()}
            day={day}
            events={events}
            blocks={blocks}
            onCreateAt={onCreateAt}
            onSelectEvent={onSelectEvent}
            onSelectBlock={onSelectBlock}
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  events,
  blocks,
  onCreateAt,
  onSelectEvent,
  onSelectBlock,
}: {
  day: Date;
  events: ExpandedEvent[];
  blocks: CalendarBlock[];
  onCreateAt: (s: Date, e: Date) => void;
  onSelectEvent: (id: string) => void;
  onSelectBlock?: (id: string) => void;
}) {
  const dayStart = useMemo(() => {
    const d = new Date(day);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [day]);
  const dayEnd = useMemo(() => {
    const d = new Date(dayStart);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [dayStart]);

  const items = useMemo(() => positionItemsInDay(events, blocks, dayStart, dayEnd), [events, blocks, dayStart, dayEnd]);

  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ startY: number; currentY: number } | null>(null);

  const yToTime = (y: number): Date => {
    const minutes = Math.max(0, Math.min(24 * 60 - 15, Math.round((y / HOUR_HEIGHT_PX) * 60 / 15) * 15));
    const d = new Date(dayStart);
    d.setMinutes(d.getMinutes() + minutes);
    return d;
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-event]") || target.closest("[data-block]")) return;
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setDrag({ startY: y, currentY: y });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drag || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setDrag({ ...drag, currentY: y });
  };

  const onMouseUp = () => {
    if (!drag) return;
    const minY = Math.min(drag.startY, drag.currentY);
    const maxY = Math.max(drag.startY, drag.currentY);
    const start = yToTime(minY);
    let end = yToTime(maxY);
    if (end.getTime() - start.getTime() < 15 * 60 * 1000) {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    setDrag(null);
    onCreateAt(start, end);
  };

  return (
    <div
      ref={ref}
      style={{ position: "relative", borderLeft: "1px solid var(--border)", minHeight: HOUR_HEIGHT_PX * 24 }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => setDrag(null)}
    >
      {HOURS.map((h) => (
        <div key={h} style={{ height: HOUR_HEIGHT_PX, borderTop: "1px solid var(--border)" }} />
      ))}

      {isSameDay(day, new Date()) && (
        <NowLine dayHeightPx={HOUR_HEIGHT_PX * 24} />
      )}

      {drag && (() => {
        const top = Math.min(drag.startY, drag.currentY);
        const height = Math.abs(drag.currentY - drag.startY);
        return (
          <div
            style={{
              position: "absolute",
              left: 2,
              right: 2,
              top,
              height,
              backgroundColor: "rgba(255,59,48,0.2)",
              border: "1px dashed var(--accent)",
              borderRadius: "var(--radius-sm)",
              pointerEvents: "none",
            }}
          />
        );
      })()}

      {items.map((item) => {
        const topPx = (item.topPct / 100) * HOUR_HEIGHT_PX * 24;
        const heightPx = Math.max(20, (item.heightPct / 100) * HOUR_HEIGHT_PX * 24);
        if (item.kind === "event") {
          const ev = item.raw as ExpandedEvent;
          return (
            <div
              key={item.id}
              data-event
              onClick={(e) => {
                e.stopPropagation();
                onSelectEvent(ev.id);
              }}
              style={{
                position: "absolute",
                left: 2,
                right: 2,
                top: topPx,
                height: heightPx,
                borderLeft: `3px solid ${item.color}`,
                backgroundColor: `${item.color}22`,
                borderRadius: "var(--radius-sm)",
                padding: "2px 6px",
                fontSize: "0.7rem",
                color: "var(--text-primary)",
                cursor: "pointer",
                overflow: "hidden",
              }}
            >
              <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{item.label}</div>
              {heightPx > 36 && item.sublabel && (
                <div style={{ fontSize: "0.62rem", color: "var(--text-secondary)" }}>{item.sublabel}</div>
              )}
            </div>
          );
        }
        return (
          <div
            key={item.id}
            data-block
            onClick={(e) => {
              e.stopPropagation();
              onSelectBlock?.((item.raw as CalendarBlock).id);
            }}
            title={item.label}
            style={{
              position: "absolute",
              left: 2,
              right: 2,
              top: topPx,
              height: heightPx,
              background:
                "repeating-linear-gradient(45deg, var(--surface-elevated) 0 8px, var(--surface-hover) 8px 16px)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm)",
              padding: "2px 6px",
              fontSize: "0.68rem",
              color: "var(--text-secondary)",
              cursor: onSelectBlock ? "pointer" : "default",
              overflow: "hidden",
            }}
          >
            🚫 {item.label}
          </div>
        );
      })}
    </div>
  );
}
