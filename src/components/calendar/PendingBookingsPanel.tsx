"use client";

import { useState } from "react";
import { X, Check, Ban, Mail, Phone, MessageSquare } from "lucide-react";
import { approveBookingApi, rejectBookingApi } from "@/lib/calendar-client";
import type { Booking } from "@/lib/calendar-types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  items: Booking[];
}

export function PendingBookingsPanel({ isOpen, onClose, onChanged, items }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const approve = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await approveBookingApi(id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: string) => {
    const reason = prompt("Motivo da rejeição (opcional):") ?? undefined;
    setBusy(id);
    setError(null);
    try {
      await rejectBookingApi(id, reason);
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
            Pedidos de agendamento ({items.length})
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

          {items.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--text-secondary)", padding: "2rem" }}>
              Nenhum pedido pendente.
            </div>
          ) : (
            items.map((b) => (
              <div
                key={b.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  padding: "1rem",
                  backgroundColor: "var(--surface-elevated)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "1rem" }}>{b.name}</div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "0.75rem",
                        color: "var(--text-secondary)",
                        fontSize: "0.8rem",
                        marginTop: 4,
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Mail className="w-3 h-3" /> {b.requester_email}
                      </span>
                      {b.requester_phone && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Phone className="w-3 h-3" /> {b.requester_phone}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 8, fontSize: "0.85rem", color: "var(--text-primary)" }}>
                      📅{" "}
                      {new Date(b.start_at).toLocaleString("pt-BR", {
                        weekday: "long",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      –{" "}
                      {new Date(b.end_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    {b.message && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "0.5rem 0.75rem",
                          backgroundColor: "var(--surface)",
                          borderRadius: "var(--radius-md)",
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                          display: "flex",
                          gap: 6,
                          alignItems: "flex-start",
                        }}
                      >
                        <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <span>{b.message}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => approve(b.id)}
                      disabled={busy === b.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0.4rem 0.75rem",
                        borderRadius: "var(--radius-md)",
                        backgroundColor: "var(--positive)",
                        color: "#000",
                        border: "none",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: "0.78rem",
                      }}
                    >
                      <Check className="w-3.5 h-3.5" />
                      Aprovar
                    </button>
                    <button
                      type="button"
                      onClick={() => reject(b.id)}
                      disabled={busy === b.id}
                      className="btn-danger"
                      style={{ padding: "0.4rem 0.75rem", fontSize: "0.78rem" }}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      Rejeitar
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
