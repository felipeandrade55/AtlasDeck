"use client";

import { useMemo } from "react";
import { MapPin, Repeat, CheckCircle2, Circle } from "lucide-react";
import type { ExpandedEvent, CalendarBlock } from "@/lib/calendar-types";

interface Props {
  events: ExpandedEvent[];
  blocks: CalendarBlock[];
  onSelectEvent: (eventId: string, occurrenceDate?: string | null, completed?: boolean) => void;
  onToggleComplete: (eventId: string, occurrenceDate: string | null, completed: boolean) => void;
}

function fmtDay(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);

  if (target.getTime() === today.getTime()) return "Hoje";
  if (target.getTime() === tomorrow.getTime()) return "Amanhã";

  return d.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

interface AgendaItem {
  kind: "event" | "block";
  start: Date;
  end: Date;
  data: ExpandedEvent | CalendarBlock;
}

export function AgendaView({ events, blocks, onSelectEvent, onToggleComplete }: Props) {
  const groups = useMemo(() => {
    const items: AgendaItem[] = [];
    for (const ev of events) {
      items.push({ kind: "event", start: new Date(ev.start_at), end: new Date(ev.end_at), data: ev });
    }
    for (const b of blocks) {
      items.push({ kind: "block", start: new Date(b.start_at), end: new Date(b.end_at), data: b });
    }
    items.sort((a, b) => a.start.getTime() - b.start.getTime());

    const map = new Map<string, { date: Date; items: AgendaItem[] }>();
    for (const it of items) {
      // Use local date components to avoid UTC-midnight shift (e.g. BRT = UTC-3)
      const d = it.start;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const bucket = map.get(key) ?? { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), items: [] };
      bucket.items.push(it);
      map.set(key, bucket);
    }
    return Array.from(map.entries()).map(([key, { date, items: list }]) => ({ key, date, items: list }));
  }, [events, blocks]);

  if (groups.length === 0) {
    return (
      <div
        style={{
          padding: "3rem",
          textAlign: "center",
          color: "var(--text-secondary)",
          backgroundColor: "var(--surface)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border)",
        }}
      >
        Nenhum compromisso no período.
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {groups.map((group) => (
        <div key={group.key} style={{ borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              padding: "0.75rem 1rem",
              backgroundColor: "var(--surface-elevated)",
              fontSize: "0.85rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              textTransform: "capitalize",
            }}
          >
            {fmtDay(group.date)}
          </div>
          {group.items.map((it, idx) => {
            if (it.kind === "event") {
              const ev = it.data as ExpandedEvent;
              const completed = !!ev.completed_at;
              const color = completed ? "var(--positive)" : ev.color || "#FF3B30";
              return (
                <div
                  key={`${ev.id}-${idx}`}
                  style={{
                    display: "flex",
                    alignItems: "stretch",
                    gap: "0.75rem",
                    padding: "0.75rem 1rem",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      width: 4,
                      borderRadius: 2,
                      backgroundColor: color,
                      flexShrink: 0,
                    }}
                  />
                  <button
                    type="button"
                    title={completed ? "Marcar como não realizado" : "Marcar como realizado"}
                    aria-label={completed ? "Marcar como não realizado" : "Marcar como realizado"}
                    onClick={() => onToggleComplete(ev.id, ev.occurrence_date, !completed)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      color: completed ? "var(--positive)" : "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  >
                    {completed ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectEvent(ev.id, ev.occurrence_date, completed)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "block",
                      backgroundColor: "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      color: "var(--text-primary)",
                      padding: 0,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "0.9rem",
                          textDecoration: completed ? "line-through" : "none",
                          color: completed ? "var(--positive)" : "var(--text-primary)",
                        }}
                      >
                        {ev.title}
                      </div>
                      <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                        {ev.all_day
                          ? "Dia inteiro"
                          : `${it.start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} – ${it.end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.75rem",
                        fontSize: "0.75rem",
                        color: "var(--text-muted)",
                        marginTop: 2,
                      }}
                    >
                      {completed && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--positive)", fontWeight: 600 }}>
                          <CheckCircle2 className="w-3 h-3" />
                          Realizado
                        </span>
                      )}
                      {ev.location && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <MapPin className="w-3 h-3" />
                          {ev.location}
                        </span>
                      )}
                      {ev.is_recurring_instance && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Repeat className="w-3 h-3" />
                          recorrente
                        </span>
                      )}
                      {ev.source !== "ui" && (
                        <span style={{ textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5 }}>
                          {ev.source}
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              );
            }
            const block = it.data as CalendarBlock;
            return (
              <div
                key={`block-${block.id}-${idx}`}
                style={{
                  padding: "0.75rem 1rem",
                  background:
                    "repeating-linear-gradient(45deg, var(--surface-elevated) 0 8px, var(--surface-hover) 8px 16px)",
                  borderBottom: "1px solid var(--border)",
                  fontSize: "0.85rem",
                  color: "var(--text-secondary)",
                }}
              >
                🚫 <b>Bloqueado</b>: {block.title || block.reason || "Indisponível"}{" "}
                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                  {it.start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} –{" "}
                  {it.end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
