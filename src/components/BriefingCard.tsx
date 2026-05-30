"use client";

/**
 * Briefing card for the dashboard.
 *
 * Shows how many WhatsApp Assessor conversations are pending Felipe's
 * review, broken down by urgency, with a link to the full briefing
 * page. Polls every 30s so a brand-new urgent recado lights up the
 * dashboard within the polling window.
 *
 * When there's nothing pending, the card renders a quiet "empty" state
 * so it doesn't dominate the layout — but stays visible to advertise
 * the existence of the feature.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Inbox,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

type Urgency = "low" | "normal" | "medium" | "high" | "urgent";

interface BriefingSummary {
  totalPending: number;
  bySender: Array<{ senderJid: string; senderName: string | null; count: number }>;
  byUrgency: Record<Urgency, number>;
  oldestPendingMs: number | null;
  newestPendingMs: number | null;
}

interface BriefingEntry {
  id: string;
  senderJid: string;
  senderName: string | null;
  summary: string;
  urgency: Urgency;
  createdAt: number;
}

const URGENCY_META: Record<Urgency, { color: string; icon: string; label: string }> = {
  urgent: { color: "#fca5a5", icon: "🔴", label: "Urgente" },
  high: { color: "#fbbf24", icon: "🟠", label: "Alta" },
  medium: { color: "#fde68a", icon: "🟡", label: "Média" },
  normal: { color: "#94a3b8", icon: "⚪", label: "Normal" },
  low: { color: "#64748b", icon: "⚫", label: "Baixa" },
};

function timeAgo(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function BriefingCard() {
  const [summary, setSummary] = useState<BriefingSummary | null>(null);
  const [entries, setEntries] = useState<BriefingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/integrations/whatsapp/briefing?onlyPending=1&summary=1&limit=5",
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSummary(json.summary as BriefingSummary);
      setEntries(json.entries as BriefingEntry[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    const t = setInterval(() => void fetchData(), 30_000);
    return () => clearInterval(t);
  }, []);

  const total = summary?.totalPending ?? 0;
  const hasUrgent = (summary?.byUrgency?.urgent ?? 0) > 0;
  const hasHigh = (summary?.byUrgency?.high ?? 0) > 0;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <Inbox
            className="w-4 h-4"
            style={{ color: hasUrgent ? "#fca5a5" : hasHigh ? "#fbbf24" : "var(--accent)" }}
          />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Recados WhatsApp (Assessor)
          </span>
          {total > 0 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded font-mono"
              style={{
                backgroundColor: hasUrgent
                  ? "rgba(248,113,113,0.2)"
                  : hasHigh
                    ? "rgba(251,191,36,0.2)"
                    : "rgba(255,255,255,0.06)",
                color: hasUrgent ? "#fca5a5" : hasHigh ? "#fbbf24" : "var(--text-secondary)",
              }}
            >
              {total} pendente{total === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void fetchData()}
            disabled={loading}
            className="p-1 rounded hover:bg-white/5 disabled:opacity-50"
            title="Atualizar"
            style={{ color: "var(--text-muted)" }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <Link
            href="/whatsapp/briefing"
            className="p-1 rounded hover:bg-white/5"
            title="Ver tudo"
            style={{ color: "var(--text-muted)" }}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2 text-xs">
        {error && (
          <div className="flex items-center gap-1.5 text-red-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        {!error && total === 0 && (
          <div className="flex items-center gap-2 py-2" style={{ color: "var(--text-muted)" }}>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Sem recados pendentes. O assessor está em dia.</span>
          </div>
        )}

        {!error && total > 0 && (
          <>
            {/* Urgency breakdown chips */}
            <div className="flex flex-wrap gap-1.5">
              {(["urgent", "high", "medium", "normal", "low"] as Urgency[])
                .filter((u) => (summary?.byUrgency?.[u] ?? 0) > 0)
                .map((u) => (
                  <span
                    key={u}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      backgroundColor: "rgba(255,255,255,0.04)",
                      color: URGENCY_META[u].color,
                    }}
                    title={URGENCY_META[u].label}
                  >
                    {URGENCY_META[u].icon} {summary?.byUrgency?.[u]}
                  </span>
                ))}
              {summary?.oldestPendingMs && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px]"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.04)",
                    color: "var(--text-muted)",
                  }}
                >
                  mais antigo: {timeAgo(summary.oldestPendingMs)}
                </span>
              )}
            </div>

            {/* Last few entries */}
            <ul className="space-y-1.5 mt-2">
              {entries.slice(0, 4).map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-2 py-1.5 px-2 rounded"
                  style={{ backgroundColor: "rgba(255,255,255,0.02)" }}
                >
                  <span className="text-[10px] mt-0.5">{URGENCY_META[e.urgency].icon}</span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-[11px] font-medium truncate"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {e.senderName || e.senderJid.split("@")[0]}
                    </div>
                    <div
                      className="text-[11px] line-clamp-2"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {e.summary}
                    </div>
                  </div>
                  <span
                    className="text-[10px] shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {timeAgo(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>

            <Link
              href="/whatsapp/briefing"
              className="block text-center text-[11px] py-1.5 mt-2 rounded hover:bg-white/5"
              style={{ color: "var(--accent)" }}
            >
              Ver todos os {total} recados →
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
