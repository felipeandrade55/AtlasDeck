"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { use } from "react";
import { CalendarDays, Clock, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import { addDays, isSameDay, startOfDay } from "date-fns";

interface LinkInfo {
  id: string;
  token: string;
  title: string;
  description: string | null;
  duration_minutes: number;
}

interface Slot {
  start_at: string;
  end_at: string;
}

interface Props {
  params: Promise<{ token: string }>;
}

export default function PublicBookingPage({ params }: Props) {
  const { token } = use(params);

  const [link, setLink] = useState<LinkInfo | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date>(() => startOfDay(new Date()));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = new Date();
      const to = addDays(from, 30);
      const res = await fetch(
        `/api/calendar/public/${token}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(
          to.toISOString()
        )}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao carregar link");
      }
      setLink(data.link);
      setSlots(data.slots);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of slots) {
      const key = startOfDay(new Date(slot.start_at)).toISOString();
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return map;
  }, [slots]);

  const daysWithSlots = useMemo(() => {
    const days: Date[] = [];
    const today = startOfDay(new Date());
    for (let i = 0; i < 30; i++) {
      const d = addDays(today, i);
      if (slotsByDay.get(d.toISOString())?.length) days.push(d);
    }
    return days;
  }, [slotsByDay]);

  useEffect(() => {
    if (daysWithSlots.length > 0 && !slotsByDay.get(startOfDay(selectedDay).toISOString())) {
      setSelectedDay(daysWithSlots[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysWithSlots.length]);

  const todaySlots = slotsByDay.get(startOfDay(selectedDay).toISOString()) ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlot) return;
    if (!name.trim() || !email.trim()) {
      setError("Preencha nome e e-mail");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/calendar/public/${token}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_at: selectedSlot.start_at,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          message: message.trim() || undefined,
          website,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao agendar");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reload();
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-secondary)" }}>Carregando...</div>
    );
  }

  if (!link) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-secondary)" }}>
        <h1 style={{ color: "var(--text-primary)", marginBottom: "0.5rem" }}>Link indisponível</h1>
        <p>{error || "Este link expirou ou não está mais ativo."}</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "2.5rem",
            textAlign: "center",
            color: "var(--text-primary)",
          }}
        >
          <CheckCircle2 className="w-12 h-12 mx-auto" style={{ color: "var(--positive)", marginBottom: 16 }} />
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "1.5rem",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Pedido enviado!
          </h1>
          <p style={{ color: "var(--text-secondary)" }}>
            Recebemos seu pedido de agendamento. Você será avisado por e-mail assim que for confirmado.
          </p>
          {selectedSlot && (
            <div
              style={{
                marginTop: 24,
                padding: "1rem",
                backgroundColor: "var(--surface-elevated)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-secondary)",
                fontSize: "0.9rem",
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{link.title}</div>
              <div>
                {new Date(selectedSlot.start_at).toLocaleString("pt-BR", {
                  weekday: "long",
                  day: "2-digit",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1rem",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 920,
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "2rem",
            borderRight: "1px solid var(--border)",
            backgroundColor: "var(--surface-elevated)",
          }}
        >
          <div
            style={{
              fontSize: "0.7rem",
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--accent)",
              marginBottom: 8,
            }}
          >
            AtlasDeck
          </div>
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "1.6rem",
              fontWeight: 700,
              color: "var(--text-primary)",
              lineHeight: 1.15,
              marginBottom: 12,
            }}
          >
            {link.title}
          </h1>
          {link.description && (
            <p style={{ color: "var(--text-secondary)", marginBottom: 16 }}>{link.description}</p>
          )}
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              color: "var(--text-secondary)",
              fontSize: "0.85rem",
              marginTop: 16,
            }}
          >
            <Clock className="w-4 h-4" />
            {link.duration_minutes} minutos
          </div>
          {selectedSlot && (
            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 12,
                alignItems: "center",
                color: "var(--text-primary)",
                fontSize: "0.85rem",
              }}
            >
              <CalendarDays className="w-4 h-4" />
              {new Date(selectedSlot.start_at).toLocaleString("pt-BR", {
                weekday: "short",
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>

        <div style={{ padding: "2rem" }}>
          {!selectedSlot && (
            <>
              <h2
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "1.2rem",
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  marginBottom: 16,
                }}
              >
                Escolha um horário
              </h2>

              {daysWithSlots.length === 0 ? (
                <div style={{ color: "var(--text-secondary)" }}>
                  Nenhum horário disponível nos próximos 30 dias.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      marginBottom: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    {daysWithSlots.map((d) => {
                      const active = isSameDay(d, selectedDay);
                      return (
                        <button
                          key={d.toISOString()}
                          type="button"
                          onClick={() => setSelectedDay(d)}
                          style={{
                            padding: "0.5rem 0.85rem",
                            borderRadius: "var(--radius-md)",
                            background: active ? "var(--accent)" : "var(--surface-elevated)",
                            color: active ? "#fff" : "var(--text-secondary)",
                            border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                            cursor: "pointer",
                            fontSize: "0.82rem",
                            fontWeight: active ? 700 : 500,
                          }}
                        >
                          {d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" })}
                        </button>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
                      gap: 8,
                      maxHeight: 320,
                      overflowY: "auto",
                    }}
                  >
                    {todaySlots.map((slot) => (
                      <button
                        key={slot.start_at}
                        type="button"
                        onClick={() => setSelectedSlot(slot)}
                        style={{
                          padding: "0.6rem",
                          borderRadius: "var(--radius-md)",
                          background: "var(--surface-elevated)",
                          color: "var(--positive)",
                          border: "1px solid var(--positive)",
                          cursor: "pointer",
                          fontWeight: 600,
                          fontSize: "0.9rem",
                        }}
                      >
                        {new Date(slot.start_at).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {selectedSlot && (
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <button
                type="button"
                onClick={() => setSelectedSlot(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary)",
                  fontSize: "0.82rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                  alignSelf: "flex-start",
                }}
              >
                <ChevronLeft className="w-4 h-4" />
                Trocar horário
              </button>

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

              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome *"
                className="input"
                required
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Seu e-mail *"
                className="input"
                required
              />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Telefone (opcional)"
                className="input"
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Mensagem (opcional)"
                rows={3}
                className="input"
                style={{ resize: "vertical" }}
              />

              {/* Honeypot — fica escondido */}
              <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                style={{ position: "absolute", left: "-9999px", opacity: 0 }}
                aria-hidden
              />

              <button
                type="submit"
                disabled={submitting}
                className="btn-primary"
                style={{ marginTop: 8, justifyContent: "center" }}
              >
                {submitting ? "Enviando..." : "Solicitar agendamento"}
                <ChevronRight className="w-4 h-4" />
              </button>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center" }}>
                Seu pedido entra como pendente e será confirmado pelo dono da agenda.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
