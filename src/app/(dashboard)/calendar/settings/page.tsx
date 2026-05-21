"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Copy, ArrowLeft, Power, PowerOff } from "lucide-react";
import {
  createBookingLinkApi,
  deleteBookingLinkApi,
  fetchBookingLinks,
} from "@/lib/calendar-client";
import type { AvailabilityRule, BookingLink } from "@/lib/calendar-types";

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export default function CalendarSettingsPage() {
  const [rules, setRules] = useState<AvailabilityRule[]>([]);
  const [links, setLinks] = useState<BookingLink[]>([]);
  const [newRule, setNewRule] = useState({
    day_of_week: 1,
    start_time: "09:00",
    end_time: "18:00",
    slot_minutes: 30,
    lunch_enabled: false,
    lunch_start: "12:00",
    lunch_end: "13:00",
  });
  const [newLink, setNewLink] = useState({
    title: "",
    duration_minutes: 30,
    description: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [rulesRes, linksData] = await Promise.all([
        fetch("/api/calendar/availability/rules", { cache: "no-store" }).then((r) => r.json()),
        fetchBookingLinks(),
      ]);
      setRules(rulesRes.rules ?? []);
      setLinks(linksData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const createRule = async () => {
    setError(null);
    try {
      const payload = {
        day_of_week: newRule.day_of_week,
        start_time: newRule.start_time,
        end_time: newRule.end_time,
        slot_minutes: newRule.slot_minutes,
        lunch_start: newRule.lunch_enabled ? newRule.lunch_start : null,
        lunch_end: newRule.lunch_enabled ? newRule.lunch_end : null,
      };
      const res = await fetch("/api/calendar/availability/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Excluir esta regra?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/calendar/availability/rules?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleRule = async (rule: AvailabilityRule) => {
    setError(null);
    try {
      await fetch(`/api/calendar/availability/rules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, active: !rule.active }),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const createLink = async () => {
    setError(null);
    if (!newLink.title.trim()) {
      setError("Título é obrigatório");
      return;
    }
    try {
      await createBookingLinkApi({
        title: newLink.title.trim(),
        duration_minutes: newLink.duration_minutes,
        description: newLink.description.trim() || undefined,
      });
      setNewLink({ title: "", duration_minutes: 30, description: "" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteLink = async (id: string) => {
    if (!confirm("Excluir este link?")) return;
    try {
      await deleteBookingLinkApi(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const linkUrl = (token: string) => {
    const envBase = process.env.NEXT_PUBLIC_PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (envBase) return `${envBase}/book/${token}`;
    if (typeof window === "undefined") return `/book/${token}`;
    return `${window.location.origin}/book/${token}`;
  };

  const copyLink = async (token: string) => {
    const url = linkUrl(token);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    if (ok) {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken((cur) => (cur === token ? null : cur)), 1800);
    } else {
      setError("Não foi possível copiar — selecione o link manualmente.");
    }
  };

  return (
    <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <Link
          href="/calendar"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--text-secondary)",
            textDecoration: "none",
            fontSize: "0.85rem",
          }}
        >
          <ArrowLeft className="w-4 h-4" />
          Voltar ao calendário
        </Link>
      </div>

      <div>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.75rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            marginBottom: "0.25rem",
          }}
        >
          Configurações do calendário
        </h1>
        <p style={{ color: "var(--text-secondary)" }}>
          Defina quando você aceita reuniões e gerencie links públicos de agendamento.
        </p>
      </div>

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

      <section
        style={{
          padding: "1.5rem",
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.1rem",
            fontWeight: 600,
            marginBottom: "1rem",
            color: "var(--text-primary)",
          }}
        >
          Janelas de disponibilidade
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          Defina os dias e horários em que terceiros podem solicitar slots pelo link público.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 110px 110px 90px auto",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <select
            value={newRule.day_of_week}
            onChange={(e) => setNewRule({ ...newRule, day_of_week: Number(e.target.value) })}
            className="input"
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={newRule.start_time}
            onChange={(e) => setNewRule({ ...newRule, start_time: e.target.value })}
            className="input"
          />
          <input
            type="time"
            value={newRule.end_time}
            onChange={(e) => setNewRule({ ...newRule, end_time: e.target.value })}
            className="input"
          />
          <input
            type="number"
            min={5}
            max={240}
            value={newRule.slot_minutes}
            onChange={(e) => setNewRule({ ...newRule, slot_minutes: Number(e.target.value) })}
            className="input"
          />
          <button onClick={createRule} className="btn-primary" style={{ fontSize: "0.85rem" }}>
            <Plus className="w-4 h-4" />
            Adicionar
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1rem",
            fontSize: "0.82rem",
            color: "var(--text-secondary)",
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={newRule.lunch_enabled}
              onChange={(e) => setNewRule({ ...newRule, lunch_enabled: e.target.checked })}
            />
            Bloquear horário de almoço
          </label>
          <input
            type="time"
            value={newRule.lunch_start}
            onChange={(e) => setNewRule({ ...newRule, lunch_start: e.target.value })}
            className="input"
            disabled={!newRule.lunch_enabled}
            style={{ width: 110 }}
          />
          <span>até</span>
          <input
            type="time"
            value={newRule.lunch_end}
            onChange={(e) => setNewRule({ ...newRule, lunch_end: e.target.value })}
            className="input"
            disabled={!newRule.lunch_enabled}
            style={{ width: 110 }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {rules.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
              Nenhuma regra cadastrada ainda.
            </div>
          )}
          {rules.map((r) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr auto auto",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.5rem 1rem",
                backgroundColor: "var(--surface-elevated)",
                borderRadius: "var(--radius-md)",
                opacity: r.active ? 1 : 0.55,
              }}
            >
              <div style={{ fontWeight: 600 }}>{WEEKDAYS[r.day_of_week]}</div>
              <div style={{ color: "var(--text-secondary)" }}>
                {r.start_time} – {r.end_time}
                {r.lunch_start && r.lunch_end && (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginLeft: 6 }}>
                    (almoço {r.lunch_start}–{r.lunch_end})
                  </span>
                )}
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                slots de {r.slot_minutes}min
              </div>
              <button
                type="button"
                onClick={() => toggleRule(r)}
                style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
                title={r.active ? "Desativar" : "Ativar"}
              >
                {r.active ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => deleteRule(r.id)}
                style={{ background: "none", border: "none", color: "var(--negative)", cursor: "pointer" }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section
        style={{
          padding: "1.5rem",
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.1rem",
            fontWeight: 600,
            marginBottom: "1rem",
            color: "var(--text-primary)",
          }}
        >
          Links de agendamento públicos
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          Cada link gera uma URL fixa que você pode compartilhar. Pedidos chegam como pendentes para sua aprovação.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 120px 1fr auto",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <input
            type="text"
            value={newLink.title}
            onChange={(e) => setNewLink({ ...newLink, title: e.target.value })}
            placeholder="Título (ex: Reunião 30min)"
            className="input"
          />
          <input
            type="number"
            min={5}
            max={480}
            value={newLink.duration_minutes}
            onChange={(e) => setNewLink({ ...newLink, duration_minutes: Number(e.target.value) })}
            className="input"
            placeholder="Duração (min)"
          />
          <input
            type="text"
            value={newLink.description}
            onChange={(e) => setNewLink({ ...newLink, description: e.target.value })}
            placeholder="Descrição (opcional)"
            className="input"
          />
          <button onClick={createLink} className="btn-primary" style={{ fontSize: "0.85rem" }}>
            <Plus className="w-4 h-4" />
            Criar
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {links.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Nenhum link ainda.</div>
          )}
          {links.map((link) => (
            <div
              key={link.id}
              style={{
                padding: "0.75rem 1rem",
                backgroundColor: "var(--surface-elevated)",
                borderRadius: "var(--radius-md)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  {link.title} · {link.duration_minutes} min
                </div>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {linkUrl(link.token)}
                </div>
                {link.description && (
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 2 }}>
                    {link.description}
                  </div>
                )}
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                  {link.uses} usos
                </div>
              </div>
              <button
                type="button"
                onClick={() => copyLink(link.token)}
                className="btn-outline"
                style={{ padding: "0.4rem 0.7rem", fontSize: "0.78rem" }}
              >
                <Copy className="w-3.5 h-3.5" />
                {copiedToken === link.token ? "Copiado!" : "Copiar"}
              </button>
              <button
                type="button"
                onClick={() => deleteLink(link.id)}
                style={{ background: "none", border: "none", color: "var(--negative)", cursor: "pointer" }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
