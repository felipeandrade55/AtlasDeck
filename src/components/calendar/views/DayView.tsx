"use client";

import { useMemo, useRef, useState } from "react";
import type { ExpandedEvent, CalendarBlock } from "@/lib/calendar-types";
import { HOURS, fmtHour, positionItemsInDay } from "./_utils";

interface Props {
  focusDate: Date;
  events: ExpandedEvent[];
  blocks: CalendarBlock[];
  onCreateAt: (start: Date, end: Date) => void;
  onSelectEvent: (eventId: string) => void;
  onSelectBlock?: (blockId: string) => void;
}

const HOUR_HEIGHT_PX = 48;

export function DayView({ focusDate, events, blocks, onCreateAt, onSelectEvent, onSelectBlock }: Props) {
  const dayStart = useMemo(() => {
    const d = new Date(focusDate);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [focusDate]);
  const dayEnd = useMemo(() => {
    const d = new Date(dayStart);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [dayStart]);

  const items = useMemo(() => positionItemsInDay(events, blocks, dayStart, dayEnd), [events, blocks, dayStart, dayEnd]);

  const containerRef = useRef<HTMLDivElement | null>(null);
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
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + containerRef.current.scrollTop;
    setDrag({ startY: y, currentY: y });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drag || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + containerRef.current.scrollTop;
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
      ref={containerRef}
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        overflowY: "auto",
        maxHeight: "calc(100vh - 200px)",
        backgroundColor: "var(--surface)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border)",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => setDrag(null)}
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

      <div style={{ position: "relative", borderLeft: "1px solid var(--border)" }}>
        {HOURS.map((h) => (
          <div
            key={h}
            style={{
              height: HOUR_HEIGHT_PX,
              borderTop: "1px solid var(--border)",
            }}
          />
        ))}

        {drag && (() => {
          const top = Math.min(drag.startY, drag.currentY);
          const height = Math.abs(drag.currentY - drag.startY);
          return (
            <div
              style={{
                position: "absolute",
                left: 4,
                right: 4,
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
            return (
              <div
                key={item.id}
                data-event
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEvent((item.raw as ExpandedEvent).id);
                }}
                style={{
                  position: "absolute",
                  left: 6,
                  right: 6,
                  top: topPx,
                  height: heightPx,
                  borderLeft: `3px solid ${item.color}`,
                  backgroundColor: `${item.color}22`,
                  borderRadius: "var(--radius-sm)",
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  overflow: "hidden",
                }}
              >
                <div style={{ fontWeight: 600 }}>{item.label}</div>
                {item.sublabel && (
                  <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>{item.sublabel}</div>
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
                left: 6,
                right: 6,
                top: topPx,
                height: heightPx,
                background:
                  "repeating-linear-gradient(45deg, var(--surface-elevated) 0 8px, var(--surface-hover) 8px 16px)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 8px",
                fontSize: "0.7rem",
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
    </div>
  );
}
