import type { ExpandedEvent, CalendarBlock } from "@/lib/calendar-types";

export const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function fmtTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

export function fmtDayLabel(d: Date): string {
  const days = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  return days[d.getDay()];
}

export interface PositionedItem {
  id: string;
  topPct: number;
  heightPct: number;
  label: string;
  sublabel?: string;
  color: string;
  kind: "event" | "block";
  raw: ExpandedEvent | CalendarBlock;
}

export function positionItemsInDay(
  events: ExpandedEvent[],
  blocks: CalendarBlock[],
  dayStart: Date,
  dayEnd: Date
): PositionedItem[] {
  const totalMs = dayEnd.getTime() - dayStart.getTime();
  const items: PositionedItem[] = [];

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    if (end <= dayStart || start >= dayEnd) continue;
    const clippedStart = start < dayStart ? dayStart : start;
    const clippedEnd = end > dayEnd ? dayEnd : end;
    const topPct = ((clippedStart.getTime() - dayStart.getTime()) / totalMs) * 100;
    const heightPct = Math.max(2, ((clippedEnd.getTime() - clippedStart.getTime()) / totalMs) * 100);
    items.push({
      id: `event-${ev.id}-${ev.occurrence_date ?? ev.start_at}`,
      topPct,
      heightPct,
      label: ev.title,
      sublabel: fmtTimeRange(ev.start_at, ev.end_at),
      color: ev.color || "#FF3B30",
      kind: "event",
      raw: ev,
    });
  }

  for (const block of blocks) {
    const start = new Date(block.start_at);
    const end = new Date(block.end_at);
    if (end <= dayStart || start >= dayEnd) continue;
    const clippedStart = start < dayStart ? dayStart : start;
    const clippedEnd = end > dayEnd ? dayEnd : end;
    const topPct = ((clippedStart.getTime() - dayStart.getTime()) / totalMs) * 100;
    const heightPct = Math.max(2, ((clippedEnd.getTime() - clippedStart.getTime()) / totalMs) * 100);
    items.push({
      id: `block-${block.id}`,
      topPct,
      heightPct,
      label: block.title || block.reason || "Bloqueado",
      color: "var(--text-muted)",
      kind: "block",
      raw: block,
    });
  }

  return items;
}

export function buildHourSlots(): { hour: number; label: string }[] {
  return HOURS.map((h) => ({ hour: h, label: fmtHour(h) }));
}
