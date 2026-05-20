"use client";

import { useEffect, useState } from "react";
import { X, RefreshCw, XCircle } from "lucide-react";
import {
  applyRescheduleApi,
  cancelRescheduleApi,
  fetchRescheduleSuggestions,
} from "@/lib/calendar-client";
import type { RescheduleQueueItem } from "@/lib/calendar-types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  items: RescheduleQueueItem[];
}

interface Suggestion {
  start_at: string;
  end_at: string;
}

export function PendingReschedulePanel({ isOpen, onClose, onChanged, items }: Props) {
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [customStart, setCustomStart] = useState("");
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!openItemId) {
      setSuggestions([]);
      setCustomStart("");
      return;
    }
    setLoadingSuggestions(true);
    fetchRescheduleSuggestions(openItemId)
      .then((res) => setSuggestions(res.suggestions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingSuggestions(false));
  }, [openItemId]);

  if (!isOpen) return null;

  const apply = async (queueId: string, newStartIso: string, newEndIso?: string) => {
    setBusy(queueId);
    setError(null);
    try {
      await applyRescheduleApi(queueId, { new_start_at: newStartIso, new_end_at: newEndIso });
      setOpenItemId(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (queueId: string) => {
    if (!confirm("Cancelar este compromisso sem remarcar?")) return;
    setBusy(queueId);
    setError(null);
    try {
      await cancelRescheduleApi(queueId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

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
          <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            Compromissos a remarcar ({items.length})
          </h2>
          <button
            onClick={onClose}
            style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3">
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

          {items.length === 0 && (
            <div style={{ textAlign: "center", color: "var(--text-secondary)", padding: "2rem" }}>
              Nada pendente.
            </div>
          )}

          {items.map((item) => {
            const open = openItemId === item.id;
            const eventLike = item as RescheduleQueueItem & {
              original_event?: { title: string } | null;
              block?: { title: string | null; reason: string | null } | null;
            };
            const title = eventLike.original_event?.title ?? "Compromisso";
            const blockReason =
              eventLike.block?.reason || eventLike.block?.title || "Conflito com bloqueio";

            return (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  padding: "0.75rem 1rem",
                  backgroundColor: "var(--surface-elevated)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{title}</div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                      Estava em{" "}
                      {new Date(item.original_start).toLocaleString("pt-BR", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      — {blockReason}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => setOpenItemId(open ? null : item.id)}
                      className="btn-primary"
                      style={{ padding: "0.4rem 0.7rem", fontSize: "0.78rem" }}
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Remarcar
                    </button>
                    <button
                      type="button"
                      onClick={() => cancel(item.id)}
                      disabled={busy === item.id}
                      className="btn-danger"
                      style={{ padding: "0.4rem 0.7rem", fontSize: "0.78rem" }}
                    >
                      <XCircle className="w-3.5 h-3.5" /> Cancelar
                    </button>
                  </div>
                </div>

                {open && (
                  <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      {loadingSuggestions ? "Buscando sugestões..." : "Escolha um slot livre:"}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {suggestions.map((s) => (
                        <button
                          key={s.start_at}
                          type="button"
                          onClick={() => apply(item.id, s.start_at, s.end_at)}
                          disabled={busy === item.id}
                          style={{
                            padding: "0.4rem 0.75rem",
                            borderRadius: "var(--radius-md)",
                            backgroundColor: "var(--surface)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                            fontSize: "0.78rem",
                            cursor: "pointer",
                          }}
                        >
                          {new Date(s.start_at).toLocaleString("pt-BR", {
                            weekday: "short",
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Ou escolher manualmente:</span>
                      <input
                        type="datetime-local"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        style={{
                          padding: "0.4rem 0.6rem",
                          backgroundColor: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-md)",
                          color: "var(--text-primary)",
                          outline: "none",
                          fontSize: "0.78rem",
                        }}
                      />
                      <button
                        type="button"
                        disabled={!customStart || busy === item.id}
                        onClick={() => apply(item.id, new Date(customStart).toISOString())}
                        className="btn-outline"
                        style={{ padding: "0.4rem 0.7rem", fontSize: "0.78rem" }}
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
