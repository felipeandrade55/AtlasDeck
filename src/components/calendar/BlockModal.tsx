"use client";

import { useEffect, useState } from "react";
import { X, ShieldOff } from "lucide-react";
import { createBlockApi } from "@/lib/calendar-client";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BlockModal({ isOpen, onClose, onSaved }: Props) {
  const [allDay, setAllDay] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflicts, setConflicts] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const end = new Date(now.getTime() + 60 * 60 * 1000);
    setStartAt(toLocalInput(now));
    setEndAt(toLocalInput(end));
    setAllDay(false);
    setTitle("");
    setReason("");
    setError(null);
    setConflicts(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!startAt || !endAt) {
      setError("Preencha início e fim");
      return;
    }
    if (new Date(endAt) <= new Date(startAt)) {
      setError("Fim deve ser depois do início");
      return;
    }
    setSaving(true);
    try {
      const result = await createBlockApi({
        start_at: new Date(startAt).toISOString(),
        end_at: new Date(endAt).toISOString(),
        all_day: allDay,
        title: title.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      setConflicts(result.conflicts);
      onSaved();
      if (result.conflicts === 0) {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl shadow-2xl mx-4"
        style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div
          className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between"
          style={{ backgroundColor: "var(--surface)", borderBottom: "1px solid var(--border)" }}
        >
          <h2
            className="text-xl font-semibold flex items-center gap-2"
            style={{ color: "var(--text-primary)" }}
          >
            <ShieldOff className="w-5 h-5" /> Bloquear horário
          </h2>
          <button
            onClick={onClose}
            style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--negative-soft)",
                color: "var(--negative)",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          {conflicts !== null && conflicts > 0 && (
            <div
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--warning-soft)",
                color: "var(--warning)",
                fontSize: "0.85rem",
              }}
            >
              ⚠️ {conflicts} compromisso{conflicts > 1 ? "s" : ""} caíram nesse intervalo — confira o painel
              &quot;A remarcar&quot; na barra lateral.
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Dia(s) inteiro(s)
          </label>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? startAt.slice(0, 10) : startAt}
              onChange={(e) => setStartAt(allDay ? `${e.target.value}T00:00` : e.target.value)}
              style={{
                flex: 1,
                padding: "0.5rem 0.75rem",
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
            <span style={{ color: "var(--text-muted)" }}>→</span>
            <input
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? endAt.slice(0, 10) : endAt}
              onChange={(e) => setEndAt(allDay ? `${e.target.value}T23:59` : e.target.value)}
              style={{
                flex: 1,
                padding: "0.5rem 0.75rem",
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
          </div>

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título (opcional, ex: Consulta médica)"
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />

          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motivo (opcional)"
            rows={2}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-primary)",
              outline: "none",
              resize: "vertical",
            }}
          />

          <div
            className="flex items-center justify-end gap-3 pt-4"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <button type="button" onClick={onClose} className="btn-outline" style={{ fontSize: "0.85rem" }}>
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="btn-primary" style={{ fontSize: "0.85rem" }}>
              {saving ? "Bloqueando..." : "Bloquear"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
