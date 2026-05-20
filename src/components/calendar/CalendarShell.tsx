"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  ShieldOff,
  Settings as SettingsIcon,
  CalendarDays,
  AlertTriangle,
  Inbox,
} from "lucide-react";
import Link from "next/link";
import {
  fetchEventsInRange,
  fetchBlocks,
  fetchRescheduleQueue,
  fetchBookings,
} from "@/lib/calendar-client";
import type { CalendarBlock, ExpandedEvent, RescheduleQueueItem, Booking } from "@/lib/calendar-types";
import { useCalendarRange, navigateDate, type CalendarView } from "@/hooks/useCalendarRange";
import { MiniMonthPicker } from "./MiniMonthPicker";
import { DayView } from "./views/DayView";
import { WeekView } from "./views/WeekView";
import { MonthView } from "./views/MonthView";
import { AgendaView } from "./views/AgendaView";
import { EventModal } from "./EventModal";
import { BlockModal } from "./BlockModal";
import { PendingReschedulePanel } from "./PendingReschedulePanel";
import { PendingBookingsPanel } from "./PendingBookingsPanel";
import { InstallBanner } from "./InstallBanner";

const VIEW_OPTIONS: { id: CalendarView; label: string }[] = [
  { id: "day", label: "Dia" },
  { id: "week", label: "Semana" },
  { id: "month", label: "Mês" },
  { id: "agenda", label: "Agenda" },
];

export function CalendarShell() {
  const [view, setView] = useState<CalendarView>("week");
  const [focusDate, setFocusDate] = useState(() => new Date());
  const range = useCalendarRange(view, focusDate);

  const [events, setEvents] = useState<ExpandedEvent[]>([]);
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [rescheduleQueue, setRescheduleQueue] = useState<RescheduleQueueItem[]>([]);
  const [pendingBookings, setPendingBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalState, setModalState] = useState<{
    type: "event" | "block" | null;
    eventId: string | null;
    initialStart: Date | null;
    initialEnd: Date | null;
  }>({ type: null, eventId: null, initialStart: null, initialEnd: null });

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [bookingsOpen, setBookingsOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [evs, bls, queue, bookings] = await Promise.all([
        fetchEventsInRange(range.from, range.to),
        fetchBlocks(range.from, range.to).catch(() => [] as CalendarBlock[]),
        fetchRescheduleQueue().catch(() => ({ items: [] as RescheduleQueueItem[] })),
        fetchBookings("pending").catch(() => [] as Booking[]),
      ]);
      setEvents(evs);
      setBlocks(bls);
      setRescheduleQueue(queue.items);
      setPendingBookings(bookings);
    } catch (err) {
      console.error("Failed to load calendar data:", err);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleCreateEvent = useCallback((start: Date, end: Date) => {
    setModalState({ type: "event", eventId: null, initialStart: start, initialEnd: end });
  }, []);

  const handleSelectEvent = useCallback((eventId: string) => {
    setModalState({ type: "event", eventId, initialStart: null, initialEnd: null });
  }, []);

  const openNewEvent = () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const end = new Date(now.getTime() + 60 * 60 * 1000);
    setModalState({ type: "event", eventId: null, initialStart: now, initialEnd: end });
  };

  const openNewBlock = () => {
    setModalState({ type: "block", eventId: null, initialStart: null, initialEnd: null });
  };

  const closeModal = () => {
    setModalState({ type: null, eventId: null, initialStart: null, initialEnd: null });
  };

  const upcoming = useMemo(() => {
    const now = new Date();
    return events
      .filter((ev) => new Date(ev.start_at) >= now)
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .slice(0, 5);
  }, [events]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1rem", height: "100%" }}>
      <aside
        style={{
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          overflowY: "auto",
        }}
      >
        <button onClick={openNewEvent} className="btn-primary" style={{ width: "100%" }}>
          <Plus className="w-4 h-4" />
          Criar evento
        </button>

        <button
          onClick={openNewBlock}
          className="btn-outline"
          style={{ width: "100%", fontSize: "0.85rem" }}
        >
          <ShieldOff className="w-4 h-4" />
          Bloquear horário
        </button>

        <MiniMonthPicker focusDate={focusDate} onPick={setFocusDate} />

        {rescheduleQueue.length > 0 && (
          <button
            type="button"
            onClick={() => setRescheduleOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--warning-soft)",
              color: "var(--warning)",
              border: "1px solid var(--warning)",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
            }}
          >
            <AlertTriangle className="w-4 h-4" />
            A remarcar ({rescheduleQueue.length})
          </button>
        )}

        {pendingBookings.length > 0 && (
          <button
            type="button"
            onClick={() => setBookingsOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--info-soft)",
              color: "var(--info)",
              border: "1px solid var(--info)",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
            }}
          >
            <Inbox className="w-4 h-4" />
            Pedidos pendentes ({pendingBookings.length})
          </button>
        )}

        <div>
          <div
            style={{
              fontSize: "0.7rem",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: "var(--text-muted)",
              marginBottom: "0.5rem",
              fontWeight: 700,
            }}
          >
            Próximos
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {upcoming.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>Sem compromissos próximos</div>
            ) : (
              upcoming.map((ev) => (
                <button
                  key={`${ev.id}-${ev.start_at}`}
                  type="button"
                  onClick={() => handleSelectEvent(ev.id)}
                  style={{
                    textAlign: "left",
                    padding: "0.5rem",
                    background: "var(--surface-elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    color: "var(--text-primary)",
                    fontSize: "0.8rem",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{ev.title}</div>
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                    {new Date(ev.start_at).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <Link
          href="/calendar/settings"
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--text-secondary)",
            fontSize: "0.8rem",
            textDecoration: "none",
            padding: "0.5rem",
            borderRadius: "var(--radius-md)",
          }}
        >
          <SettingsIcon className="w-4 h-4" />
          Configurações & links
        </Link>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", gap: "0.75rem", minWidth: 0 }}>
        <InstallBanner />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.75rem 1rem",
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              onClick={() => setFocusDate(new Date())}
              className="btn-outline"
              style={{ padding: "0.375rem 0.75rem", fontSize: "0.8rem" }}
            >
              Hoje
            </button>
            <button
              onClick={() => setFocusDate(navigateDate(view, focusDate, -1))}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: 4,
              }}
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setFocusDate(navigateDate(view, focusDate, 1))}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: 4,
              }}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <h1
              style={{
                fontSize: "1.25rem",
                fontWeight: 700,
                color: "var(--text-primary)",
                fontFamily: "var(--font-heading)",
                marginLeft: "0.5rem",
                textTransform: "capitalize",
              }}
            >
              {range.label}
            </h1>
            {loading && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>carregando…</span>
            )}
          </div>

          <div className="toggle-group">
            {VIEW_OPTIONS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={view === v.id ? "active" : ""}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ minWidth: 0, overflow: "hidden" }}>
          {view === "day" && (
            <DayView
              focusDate={focusDate}
              events={events}
              blocks={blocks}
              onCreateAt={handleCreateEvent}
              onSelectEvent={handleSelectEvent}
            />
          )}
          {view === "week" && (
            <WeekView
              focusDate={focusDate}
              events={events}
              blocks={blocks}
              onCreateAt={handleCreateEvent}
              onSelectEvent={handleSelectEvent}
            />
          )}
          {view === "month" && (
            <MonthView
              focusDate={focusDate}
              events={events}
              blocks={blocks}
              onCreateAt={handleCreateEvent}
              onSelectEvent={handleSelectEvent}
              onDayClick={(d) => {
                setFocusDate(d);
                setView("day");
              }}
            />
          )}
          {view === "agenda" && (
            <AgendaView events={events} blocks={blocks} onSelectEvent={handleSelectEvent} />
          )}
        </div>

        {events.length === 0 && blocks.length === 0 && !loading && view !== "agenda" && (
          <div
            style={{
              padding: "1rem",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "0.85rem",
              backgroundColor: "var(--surface)",
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <CalendarDays className="w-4 h-4 inline-block mr-2" />
            Nenhum compromisso neste período. Arraste no grid para criar.
          </div>
        )}
      </main>

      <EventModal
        isOpen={modalState.type === "event"}
        onClose={closeModal}
        onSaved={reload}
        editingId={modalState.eventId}
        initialStart={modalState.initialStart}
        initialEnd={modalState.initialEnd}
      />

      <BlockModal
        isOpen={modalState.type === "block"}
        onClose={closeModal}
        onSaved={reload}
      />

      <PendingReschedulePanel
        isOpen={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        onChanged={reload}
        items={rescheduleQueue}
      />

      <PendingBookingsPanel
        isOpen={bookingsOpen}
        onClose={() => setBookingsOpen(false)}
        onChanged={reload}
        items={pendingBookings}
      />
    </div>
  );
}
