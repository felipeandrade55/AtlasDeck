"use client";

import { useEffect, useState } from "react";
import { X, Trash2, Calendar, Clock, MapPin, Bell, Repeat, Palette, CheckCircle2, Circle } from "lucide-react";
import { RecurrenceBuilder } from "./RecurrenceBuilder";
import {
  createEventApi,
  deleteEventApi,
  fetchEventById,
  updateEventApi,
} from "@/lib/calendar-client";
import type {
  CalendarEvent,
  EventReminder,
  EventReminderInput,
  Recurrence,
  ReminderChannel,
} from "@/lib/calendar-types";

const COLOR_OPTIONS = [
  { name: "Vermelho", value: "#FF3B30" },
  { name: "Azul", value: "#0A84FF" },
  { name: "Verde", value: "#32D74B" },
  { name: "Amarelo", value: "#FFD60A" },
  { name: "Roxo", value: "#BF5AF2" },
  { name: "Ciano", value: "#64D2FF" },
  { name: "Laranja", value: "#FF9F0A" },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  editingId: string | null;
  initialStart?: Date | null;
  initialEnd?: Date | null;
  /** Data da ocorrência (eventos recorrentes), para concluir só aquela data. */
  occurrenceDate?: string | null;
  /** Estado inicial de "realizado" deste compromisso/ocorrência. */
  initialCompleted?: boolean;
  onToggleComplete?: (eventId: string, occurrenceDate: string | null, completed: boolean) => void;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return "";
  return new Date(local).toISOString();
}

export function EventModal({
  isOpen,
  onClose,
  onSaved,
  editingId,
  initialStart,
  initialEnd,
  occurrenceDate = null,
  initialCompleted = false,
  onToggleComplete,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [color, setColor] = useState<string>(COLOR_OPTIONS[0].value);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [reminders, setReminders] = useState<EventReminderInput[]>([
    { minutes_before: 15, channel: "notification" },
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [existingSource, setExistingSource] = useState<CalendarEvent["source"] | null>(null);
  const [isCompleted, setIsCompleted] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});

    if (editingId) {
      setLoading(true);
      setIsCompleted(initialCompleted);
      fetchEventById(editingId)
        .then(({ event, reminders }) => {
          setTitle(event.title);
          setDescription(event.description ?? "");
          setLocation(event.location ?? "");
          setStartAt(toLocalInput(event.start_at));
          setEndAt(toLocalInput(event.end_at));
          setAllDay(event.all_day);
          setColor(event.color || COLOR_OPTIONS[0].value);
          setRecurrence(event.recurrence_json ? (JSON.parse(event.recurrence_json) as Recurrence) : null);
          setReminders(
            (reminders as EventReminder[]).map((r) => ({
              minutes_before: r.minutes_before,
              channel: r.channel,
            }))
          );
          setExistingSource(event.source);
        })
        .catch((err) => {
          setErrors({ general: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => setLoading(false));
    } else {
      setTitle("");
      setDescription("");
      setLocation("");
      setStartAt(toLocalInput(initialStart?.toISOString() ?? new Date().toISOString()));
      setEndAt(
        toLocalInput(
          initialEnd?.toISOString() ??
            new Date(Date.now() + 60 * 60 * 1000).toISOString()
        )
      );
      setAllDay(false);
      setColor(COLOR_OPTIONS[0].value);
      setRecurrence(null);
      setReminders([{ minutes_before: 15, channel: "notification" }]);
      setExistingSource(null);
      setIsCompleted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editingId]);

  const handleToggleCompleted = () => {
    if (!editingId) return;
    const next = !isCompleted;
    setIsCompleted(next);
    onToggleComplete?.(editingId, occurrenceDate, next);
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = "Título obrigatório";
    if (!startAt) next.startAt = "Início obrigatório";
    if (!endAt) next.endAt = "Fim obrigatório";
    if (startAt && endAt && new Date(endAt) <= new Date(startAt))
      next.endAt = "Fim deve ser depois do início";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSaving(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        start_at: fromLocalInput(startAt),
        end_at: fromLocalInput(endAt),
        all_day: allDay,
        color,
        recurrence,
        reminders,
      };

      if (editingId) {
        await updateEventApi(editingId, payload);
      } else {
        await createEventApi(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors({ general: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingId) return;
    if (!confirm("Excluir este evento?")) return;
    setIsDeleting(true);
    try {
      await deleteEventApi(editingId);
      onSaved();
      onClose();
    } catch (err) {
      setErrors({ general: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsDeleting(false);
    }
  };

  const updateReminder = (idx: number, patch: Partial<EventReminderInput>) => {
    setReminders((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl shadow-2xl mx-4"
        style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div
          className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between"
          style={{ backgroundColor: "var(--surface)", borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
              {editingId ? "Editar evento" : "Novo evento"}
            </h2>
            {existingSource && existingSource !== "ui" && (
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "2px 8px",
                  borderRadius: 6,
                  backgroundColor: existingSource === "openclaw" ? "rgba(50,215,75,0.15)" : "rgba(10,132,255,0.15)",
                  color: existingSource === "openclaw" ? "var(--positive)" : "var(--info)",
                }}
              >
                {existingSource === "openclaw" ? "OPENCLAW" : "BOOKING"}
              </span>
            )}
            {editingId && isCompleted && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "2px 8px",
                  borderRadius: 6,
                  backgroundColor: "var(--positive-soft)",
                  color: "var(--positive)",
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Realizado
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg"
            style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-secondary)" }}>
            Carregando...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {errors.general && (
              <div
                style={{
                  padding: "0.75rem 1rem",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--negative-soft)",
                  color: "var(--negative)",
                  fontSize: "0.85rem",
                }}
              >
                {errors.general}
              </div>
            )}

            <div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Adicionar título"
                style={{
                  width: "100%",
                  padding: "0.75rem 0",
                  background: "transparent",
                  border: "none",
                  borderBottom: `2px solid ${errors.title ? "var(--negative)" : "var(--border)"}`,
                  color: "var(--text-primary)",
                  fontSize: "1.5rem",
                  fontFamily: "var(--font-heading)",
                  outline: "none",
                }}
              />
              {errors.title && (
                <p style={{ color: "var(--negative)", fontSize: "0.8rem", marginTop: 4 }}>{errors.title}</p>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Clock className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", flex: 1 }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type={allDay ? "date" : "datetime-local"}
                    value={allDay ? startAt.slice(0, 10) : startAt}
                    onChange={(e) =>
                      setStartAt(allDay ? `${e.target.value}T00:00` : e.target.value)
                    }
                    style={{
                      padding: "0.5rem 0.75rem",
                      backgroundColor: "var(--surface-elevated)",
                      border: `1px solid ${errors.startAt ? "var(--negative)" : "var(--border)"}`,
                      borderRadius: "var(--radius-md)",
                      color: "var(--text-primary)",
                      outline: "none",
                      fontSize: "0.9rem",
                    }}
                  />
                  <span style={{ color: "var(--text-muted)" }}>→</span>
                  <input
                    type={allDay ? "date" : "datetime-local"}
                    value={allDay ? endAt.slice(0, 10) : endAt}
                    onChange={(e) =>
                      setEndAt(allDay ? `${e.target.value}T23:59` : e.target.value)
                    }
                    style={{
                      padding: "0.5rem 0.75rem",
                      backgroundColor: "var(--surface-elevated)",
                      border: `1px solid ${errors.endAt ? "var(--negative)" : "var(--border)"}`,
                      borderRadius: "var(--radius-md)",
                      color: "var(--text-primary)",
                      outline: "none",
                      fontSize: "0.9rem",
                    }}
                  />
                </div>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(e) => setAllDay(e.target.checked)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  Dia inteiro
                </label>
                {errors.endAt && (
                  <p style={{ color: "var(--negative)", fontSize: "0.8rem" }}>{errors.endAt}</p>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <MapPin className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Local (opcional)"
                style={{
                  flex: 1,
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--text-primary)",
                  outline: "none",
                  fontSize: "0.9rem",
                }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
              <Calendar className="w-4 h-4 mt-2" style={{ color: "var(--text-secondary)" }} />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Descrição (opcional)"
                rows={2}
                style={{
                  flex: 1,
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--text-primary)",
                  outline: "none",
                  fontSize: "0.9rem",
                  resize: "vertical",
                }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Palette className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {COLOR_OPTIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setColor(c.value)}
                    title={c.name}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      backgroundColor: c.value,
                      border: color === c.value ? "2px solid var(--text-primary)" : "2px solid transparent",
                      cursor: "pointer",
                      transition: "transform 100ms",
                      transform: color === c.value ? "scale(1.15)" : "scale(1)",
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
              <Repeat className="w-4 h-4 mt-2" style={{ color: "var(--text-secondary)" }} />
              <div style={{ flex: 1 }}>
                <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
              <Bell className="w-4 h-4 mt-2" style={{ color: "var(--text-secondary)" }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {reminders.map((r, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <input
                      type="number"
                      min={0}
                      max={20160}
                      value={r.minutes_before}
                      onChange={(e) => updateReminder(idx, { minutes_before: Number(e.target.value) })}
                      style={{
                        width: "5.5rem",
                        padding: "0.4rem 0.6rem",
                        backgroundColor: "var(--surface-elevated)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-md)",
                        color: "var(--text-primary)",
                        outline: "none",
                      }}
                    />
                    <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>min antes via</span>
                    <select
                      value={r.channel}
                      onChange={(e) => updateReminder(idx, { channel: e.target.value as ReminderChannel })}
                      style={{
                        padding: "0.4rem 0.6rem",
                        backgroundColor: "var(--surface-elevated)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-md)",
                        color: "var(--text-primary)",
                        outline: "none",
                      }}
                    >
                      <option value="notification">Interface</option>
                      <option value="telegram">Telegram</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setReminders((prev) => prev.filter((_, i) => i !== idx))}
                      style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setReminders((prev) => [...prev, { minutes_before: 15, channel: "notification" }])
                  }
                  style={{
                    alignSelf: "flex-start",
                    fontSize: "0.8rem",
                    color: "var(--accent)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "0.25rem 0",
                  }}
                >
                  + Adicionar lembrete
                </button>
              </div>
            </div>

            <div
              className="flex items-center justify-between gap-3 pt-4"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {editingId && (
                  <button
                    type="button"
                    onClick={handleToggleCompleted}
                    className="btn-outline"
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.5rem 0.85rem",
                      color: isCompleted ? "var(--positive)" : "var(--text-secondary)",
                      borderColor: isCompleted ? "var(--positive)" : "var(--border)",
                    }}
                  >
                    {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
                    {isCompleted ? "Realizado" : "Marcar como realizado"}
                  </button>
                )}
                {editingId && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="btn-danger"
                    style={{ fontSize: "0.85rem", padding: "0.5rem 0.85rem" }}
                  >
                    <Trash2 className="w-4 h-4" />
                    Excluir
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-outline"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="btn-primary"
                  style={{ padding: "0.5rem 1.25rem", fontSize: "0.85rem" }}
                >
                  {isSaving ? "Salvando..." : editingId ? "Atualizar" : "Criar"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
