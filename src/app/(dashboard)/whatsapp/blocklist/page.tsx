"use client";

/**
 * WhatsApp blocklist management page.
 *
 * Numbers added here are IGNORED by Jarvis in every operation mode — the bot
 * produces no reply at all. Reached from the briefing page header.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Ban,
  Plus,
  Trash2,
  RefreshCw,
  ShieldOff,
  AlertTriangle,
} from "lucide-react";

interface BlocklistEntry {
  phone: string;
  jid: string;
  name?: string;
  addedAt: number;
}

function formatDateTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function BlocklistPage() {
  const [entries, setEntries] = useState<BlocklistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyRemove, setBusyRemove] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/whatsapp/blocklist", { cache: "no-store" });
      const json = (await res.json()) as { entries?: BlocklistEntry[]; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/whatsapp/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim() || undefined }),
      });
      const json = (await res.json()) as { entries?: BlocklistEntry[]; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.entries ?? []);
      setPhone("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (jid: string) => {
    setBusyRemove(jid);
    setError(null);
    try {
      const res = await fetch(
        `/api/integrations/whatsapp/blocklist?jid=${encodeURIComponent(jid)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { entries?: BlocklistEntry[]; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRemove(null);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/whatsapp/briefing"
            className="p-1.5 rounded hover:bg-white/5"
            style={{ color: "var(--text-muted)" }}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Ban className="w-5 h-5" style={{ color: "#fca5a5" }} />
          <h1
            className="text-xl font-bold"
            style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}
          >
            Números bloqueados
          </h1>
          <span
            className="text-xs px-2 py-0.5 rounded font-mono"
            style={{ backgroundColor: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
          >
            {entries.length} bloqueado{entries.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={() => void fetchEntries()}
          disabled={loading}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded disabled:opacity-50"
          style={{
            backgroundColor: "rgba(255,255,255,0.04)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {/* Explainer */}
      <div
        className="rounded-lg p-3 flex items-start gap-2 text-[12px]"
        style={{
          backgroundColor: "rgba(59,130,246,0.06)",
          border: "1px solid rgba(59,130,246,0.3)",
          color: "var(--text-secondary)",
        }}
      >
        <ShieldOff className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#93c5fd" }} />
        <p>
          Mensagens vindas destes números são <strong>ignoradas pelo Jarvis em qualquer modo</strong> (assessor,
          pessoal ou aberto) — ele não responde, não reage e não registra. Informe o número com DDD e país
          (ex.: <code>5511999998888</code>).
        </p>
      </div>

      {/* Add form */}
      <form
        onSubmit={addEntry}
        className="rounded-lg p-3 flex flex-wrap items-end gap-3"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[180px]">
          <span style={{ color: "var(--text-muted)" }}>Número (com DDD/país)</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="5511999998888"
            inputMode="tel"
            className="rounded px-2 py-1.5 text-sm"
            style={{
              backgroundColor: "rgba(0,0,0,0.3)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[160px]">
          <span style={{ color: "var(--text-muted)" }}>Nome (opcional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: João spam"
            className="rounded px-2 py-1.5 text-sm"
            style={{
              backgroundColor: "rgba(0,0,0,0.3)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !phone.trim()}
          className="flex items-center gap-1 text-sm px-3 py-1.5 rounded disabled:opacity-50"
          style={{
            backgroundColor: "rgba(239,68,68,0.15)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.4)",
          }}
        >
          <Plus className="w-4 h-4" />
          {busy ? "Bloqueando…" : "Bloquear"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div
          className="rounded-lg p-3 flex items-center gap-2 text-sm"
          style={{
            backgroundColor: "rgba(239,68,68,0.08)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.3)",
          }}
        >
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Empty state */}
      {!error && entries.length === 0 && !loading && (
        <div
          className="rounded-lg p-8 text-center"
          style={{ backgroundColor: "var(--card)", border: "1px dashed var(--border)" }}
        >
          <Ban className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
          <p className="text-sm" style={{ color: "var(--text-primary)" }}>
            Nenhum número bloqueado.
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Adicione um número acima para o Jarvis passar a ignorá-lo.
          </p>
        </div>
      )}

      {/* List */}
      {entries.length > 0 && (
        <ul
          className="rounded-lg overflow-hidden"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          {entries.map((e) => (
            <li
              key={e.jid}
              className="px-4 py-3 flex items-center justify-between gap-3"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {e.name || e.phone}
                </div>
                <div className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
                  {e.jid} · bloqueado em {formatDateTime(e.addedAt)}
                </div>
              </div>
              <button
                onClick={() => void removeEntry(e.jid)}
                disabled={busyRemove !== null}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded disabled:opacity-50 shrink-0"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                <Trash2 className="w-3 h-3" />
                {busyRemove === e.jid ? "Removendo…" : "Desbloquear"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
