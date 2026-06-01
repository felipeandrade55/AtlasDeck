"use client";

/**
 * Full briefing review page for WhatsApp Assessor conversations.
 *
 * The dashboard BriefingCard shows the last 4 entries — this page lists
 * everything, lets Felipe filter by window/urgency/sender/pending-only,
 * and acknowledges (marks-as-seen) one-by-one or in bulk so the pending
 * count on the dashboard drops back to zero.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  Inbox,
  AlertTriangle,
  Eye,
  EyeOff,
  Trash2,
  Activity,
  Info,
  DollarSign,
} from "lucide-react";

type Urgency = "low" | "normal" | "medium" | "high" | "urgent";

interface BriefingEntry {
  id: string;
  accountId: string;
  senderJid: string;
  senderName: string | null;
  summary: string;
  urgency: Urgency;
  actionTaken: string | null;
  requiresFollowup: boolean;
  rawExcerpt: string | null;
  botReply: string | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt: number | null;
}

interface BriefingResponse {
  ok: boolean;
  entries: BriefingEntry[];
  count: number;
  summary?: {
    totalPending: number;
    byUrgency: Record<Urgency, number>;
    bySender: Array<{ senderJid: string; senderName: string | null; count: number }>;
  };
  error?: string;
}

interface CostEntry {
  cost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  snapshotCount: number;
  model: string | null;
}

interface CostResponse {
  ok: boolean;
  costs: Record<string, CostEntry>;
  snapshotCount: number;
  note?: string;
}

interface BriefingDiagnostics {
  mode: { operationMode: string; label: string; dmPolicy: string };
  activity: {
    last24hCount: number;
    lastTimestamp: string | null;
    lastDescription: string | null;
  };
  briefings: {
    totalEver: number;
    lastTimestamp: number | null;
    pendingCount: number;
  };
  hints: string[];
}

const URGENCY_META: Record<Urgency, { color: string; icon: string; label: string; weight: number }> = {
  urgent: { color: "#fca5a5", icon: "🔴", label: "Urgente", weight: 4 },
  high: { color: "#fbbf24", icon: "🟠", label: "Alta", weight: 3 },
  medium: { color: "#fde68a", icon: "🟡", label: "Média", weight: 2 },
  normal: { color: "#94a3b8", icon: "⚪", label: "Normal", weight: 1 },
  low: { color: "#64748b", icon: "⚫", label: "Baixa", weight: 0 },
};

const TIME_WINDOWS = [
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "3 dias" },
  { hours: 168, label: "7 dias" },
  { hours: 720, label: "30 dias" },
];

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  return `${Math.floor(hours / 24)}d atrás`;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default function BriefingPage() {
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterUrgency, setFilterUrgency] = useState<Urgency | "">("");
  const [filterSender, setFilterSender] = useState<string>("");
  const [windowHours, setWindowHours] = useState<number>(168);
  const [showAcknowledged, setShowAcknowledged] = useState<boolean>(false);
  // Filtros aplicados client-side sobre o resultado do GET (que já vem
  // recortado por janela/sender/urgência server-side). Mudança de qualquer
  // um destes NÃO re-busca a API — só re-renderiza, mantendo a UI snappy.
  const [replyFilter, setReplyFilter] = useState<"all" | "replied" | "ignored">("all");
  const [onlyFollowup, setOnlyFollowup] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>("");
  // Per-sender: usuário pediu pra ver aquele grupo como thread chat (bolhas
  // alinhadas inbound-esquerda / bot-direita) em vez da lista padrão.
  // Set armazena os JIDs em modo "thread"; default = lista.
  const [threadView, setThreadView] = useState<Set<string>>(new Set());
  const [busyAck, setBusyAck] = useState<string | null>(null);
  const [diag, setDiag] = useState<BriefingDiagnostics | null>(null);
  const [costs, setCosts] = useState<Record<string, CostEntry>>({});

  const fetchDiagnostics = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/whatsapp/briefing/diagnostics", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as BriefingDiagnostics;
      setDiag(json);
    } catch {
      // diagnostics are best-effort — never block the main view
    }
  }, []);

  // Cost correlation runs out-of-band so the entries render immediately
  // and the cost badge "fades in" once usage-tracking.db answers. Keyed by
  // windowHours so changing the time filter refetches the matching range.
  const fetchCosts = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        sinceMs: String(Date.now() - windowHours * 60 * 60 * 1000),
        limit: "500",
      });
      const res = await fetch(`/api/integrations/whatsapp/briefing/costs?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as CostResponse;
      setCosts(json.costs || {});
    } catch {
      // best-effort — UI degrades to no cost badges
    }
  }, [windowHours]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: "500",
        sinceMs: String(Date.now() - windowHours * 60 * 60 * 1000),
        summary: "1",
      });
      if (!showAcknowledged) params.set("onlyPending", "1");
      if (filterUrgency) params.set("urgency", filterUrgency);
      if (filterSender) params.set("senderJid", filterSender);
      const res = await fetch(`/api/integrations/whatsapp/briefing?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as BriefingResponse;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [windowHours, showAcknowledged, filterUrgency, filterSender]);

  useEffect(() => {
    void fetchData();
    void fetchDiagnostics();
    void fetchCosts();
  }, [fetchData, fetchDiagnostics, fetchCosts]);

  const ackOne = async (id: string) => {
    setBusyAck(id);
    try {
      await fetch("/api/integrations/whatsapp/briefing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      await fetchData();
    } finally {
      setBusyAck(null);
    }
  };

  const ackAll = async () => {
    if (!confirm("Marcar TODOS os recados pendentes como vistos?")) return;
    setBusyAck("__all__");
    try {
      await fetch("/api/integrations/whatsapp/briefing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await fetchData();
    } finally {
      setBusyAck(null);
    }
  };

  // Apply client-side filters (reply state / followup / text) BEFORE
  // grouping so empty groups disappear instead of showing as "0 mensagens".
  const filteredEntries = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) => {
      if (replyFilter === "replied" && !e.botReply) return false;
      if (replyFilter === "ignored" && e.botReply) return false;
      if (onlyFollowup && !e.requiresFollowup) return false;
      if (needle) {
        const hay = `${e.summary} ${e.botReply ?? ""} ${e.actionTaken ?? ""} ${e.senderName ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data?.entries, replyFilter, onlyFollowup, searchText]);

  // Group entries by sender for the visualization
  const grouped = useMemo(() => {
    const map = new Map<string, { jid: string; name: string | null; entries: BriefingEntry[] }>();
    for (const e of filteredEntries) {
      const existing = map.get(e.senderJid);
      if (existing) {
        existing.entries.push(e);
        if (e.senderName && !existing.name) existing.name = e.senderName;
      } else {
        map.set(e.senderJid, { jid: e.senderJid, name: e.senderName, entries: [e] });
      }
    }
    // Sort groups by highest-urgency entry first, then by most-recent
    return Array.from(map.values()).sort((a, b) => {
      const ua = Math.max(...a.entries.map((e) => URGENCY_META[e.urgency].weight));
      const ub = Math.max(...b.entries.map((e) => URGENCY_META[e.urgency].weight));
      if (ua !== ub) return ub - ua;
      const ra = Math.max(...a.entries.map((e) => e.createdAt));
      const rb = Math.max(...b.entries.map((e) => e.createdAt));
      return rb - ra;
    });
  }, [filteredEntries]);

  const total = filteredEntries.length;
  const totalRaw = data?.entries.length ?? 0;
  const summary = data?.summary;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-1.5 rounded hover:bg-white/5"
            style={{ color: "var(--text-muted)" }}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Inbox className="w-5 h-5" style={{ color: "var(--accent)" }} />
          <h1
            className="text-xl font-bold"
            style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}
          >
            Briefing do Assessor
          </h1>
          {summary?.totalPending !== undefined && (
            <span
              className="text-xs px-2 py-0.5 rounded font-mono"
              style={{
                backgroundColor:
                  summary.totalPending > 0 ? "rgba(251,191,36,0.15)" : "rgba(16,185,129,0.15)",
                color: summary.totalPending > 0 ? "#fbbf24" : "#34d399",
              }}
            >
              {summary.totalPending} pendente{summary.totalPending === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void fetchData()}
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
          {(summary?.totalPending ?? 0) > 0 && (
            <button
              onClick={() => void ackAll()}
              disabled={busyAck !== null}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded disabled:opacity-50"
              style={{
                backgroundColor: "rgba(16,185,129,0.15)",
                color: "#6ee7b7",
                border: "1px solid rgba(16,185,129,0.4)",
              }}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Marcar tudo como visto
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div
        className="rounded-lg p-3 flex flex-wrap items-center gap-3"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-1.5 text-xs">
          <span style={{ color: "var(--text-muted)" }}>Janela:</span>
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setWindowHours(w.hours)}
              className="px-2 py-1 rounded text-[11px]"
              style={{
                backgroundColor: windowHours === w.hours ? "rgba(139,92,246,0.2)" : "transparent",
                color: windowHours === w.hours ? "#c4b5fd" : "var(--text-secondary)",
                border: `1px solid ${windowHours === w.hours ? "rgba(139,92,246,0.4)" : "var(--border)"}`,
              }}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <span style={{ color: "var(--text-muted)" }}>Urgência:</span>
          <select
            value={filterUrgency}
            onChange={(e) => setFilterUrgency((e.target.value as Urgency) || "")}
            className="rounded px-2 py-1 text-[11px]"
            style={{
              backgroundColor: "rgba(0,0,0,0.3)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
          >
            <option value="">todas</option>
            <option value="urgent">🔴 urgent</option>
            <option value="high">🟠 high</option>
            <option value="medium">🟡 medium</option>
            <option value="normal">⚪ normal</option>
            <option value="low">⚫ low</option>
          </select>
        </div>

        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={showAcknowledged}
            onChange={(e) => setShowAcknowledged(e.target.checked)}
          />
          <span style={{ color: "var(--text-secondary)" }}>
            Incluir já vistos
          </span>
          {showAcknowledged ? (
            <Eye className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
          ) : (
            <EyeOff className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
          )}
        </label>

        {filterSender && (
          <button
            onClick={() => setFilterSender("")}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            <Trash2 className="w-3 h-3" />
            Limpar filtro de remetente ({filterSender.split("@")[0]})
          </button>
        )}

        <div className="flex items-center gap-1.5 text-xs">
          <span style={{ color: "var(--text-muted)" }}>Estado:</span>
          {(["all", "replied", "ignored"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setReplyFilter(v)}
              className="px-2 py-1 rounded text-[11px]"
              style={{
                backgroundColor: replyFilter === v ? "rgba(139,92,246,0.2)" : "transparent",
                color: replyFilter === v ? "#c4b5fd" : "var(--text-secondary)",
                border: `1px solid ${replyFilter === v ? "rgba(139,92,246,0.4)" : "var(--border)"}`,
              }}
            >
              {v === "all" ? "todas" : v === "replied" ? "com resposta" : "ignoradas"}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={onlyFollowup}
            onChange={(e) => setOnlyFollowup(e.target.checked)}
          />
          <span style={{ color: "var(--text-secondary)" }}>Só com retorno necessário</span>
        </label>

        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Buscar texto (summary/resposta/ação)…"
          className="rounded px-2 py-1 text-[11px] flex-1 min-w-[180px]"
          style={{
            backgroundColor: "rgba(0,0,0,0.3)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
          }}
        />

        {(replyFilter !== "all" || onlyFollowup || searchText) && (
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            mostrando {total} de {totalRaw}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          className="rounded-lg p-3 flex items-center gap-2"
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

      {/* Diagnostic banner — modo atual + atividade detectada + hint do "por que vazio" */}
      {diag && <DiagnosticBanner diag={diag} totalBriefingsShown={total} />}

      {/* Empty state */}
      {!error && total === 0 && !loading && (
        <div
          className="rounded-lg p-8 text-center"
          style={{ backgroundColor: "var(--card)", border: "1px dashed var(--border)" }}
        >
          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
          <p className="text-sm" style={{ color: "var(--text-primary)" }}>
            {showAcknowledged
              ? "Nenhum recado nessa janela com os filtros aplicados."
              : "Sem recados pendentes. O assessor está em dia."}
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Quando alguém falar com o bot no modo Assessor, o resumo aparece aqui.
          </p>
        </div>
      )}

      {/* Grouped entries */}
      <div className="space-y-4">
        {grouped.map((group) => (
          <div
            key={group.jid}
            className="rounded-lg overflow-hidden"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
          >
            <div
              className="px-4 py-2.5 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-sm font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {group.name || group.jid.split("@")[0]}
                </span>
                <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
                  {group.jid}
                </span>
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {group.entries.length} mensage{group.entries.length === 1 ? "m" : "ns"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    setThreadView((s) => {
                      const next = new Set(s);
                      if (next.has(group.jid)) next.delete(group.jid);
                      else next.add(group.jid);
                      return next;
                    })
                  }
                  className="text-[11px]"
                  style={{ color: threadView.has(group.jid) ? "#c4b5fd" : "var(--text-muted)" }}
                >
                  {threadView.has(group.jid) ? "Voltar pra lista" : "Ver como conversa"}
                </button>
                <button
                  onClick={() => setFilterSender(group.jid)}
                  className="text-[11px]"
                  style={{ color: "var(--accent)" }}
                >
                  Ver apenas este
                </button>
              </div>
            </div>

            {threadView.has(group.jid) ? (
              <ThreadView entries={group.entries} costs={costs} />
            ) : (
            <ul>
              {group.entries.map((e) => {
                const meta = URGENCY_META[e.urgency];
                const isAcked = !!e.acknowledgedAt;
                return (
                  <li
                    key={e.id}
                    className="px-4 py-3 flex items-start gap-3"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      opacity: isAcked ? 0.55 : 1,
                    }}
                  >
                    <span className="text-base mt-0.5">{meta.icon}</span>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div
                        className="text-sm"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {e.summary}
                      </div>
                      {e.actionTaken && (
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <strong>Ação:</strong> {e.actionTaken}
                        </div>
                      )}
                      {e.botReply && (
                        <div
                          className="text-[11px] rounded p-1.5 mt-1"
                          style={{
                            backgroundColor: "rgba(16,185,129,0.06)",
                            border: "1px solid rgba(16,185,129,0.2)",
                            color: "var(--text-primary)",
                          }}
                        >
                          <strong style={{ color: "#6ee7b7" }}>Bot respondeu:</strong>{" "}
                          <span style={{ whiteSpace: "pre-wrap" }}>{e.botReply}</span>
                        </div>
                      )}
                      {e.rawExcerpt && (
                        <details className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                          <summary className="cursor-pointer">trecho literal</summary>
                          <pre
                            className="mt-1 whitespace-pre-wrap p-2 rounded font-mono text-[10px]"
                            style={{ backgroundColor: "rgba(0,0,0,0.3)" }}
                          >
                            {e.rawExcerpt}
                          </pre>
                        </details>
                      )}
                      <div className="flex items-center gap-3 text-[10px] mt-1.5 flex-wrap" style={{ color: "var(--text-muted)" }}>
                        <span style={{ color: meta.color }}>{meta.label}</span>
                        {e.requiresFollowup && (
                          <span style={{ color: "#fbbf24" }}>↩ exige retorno</span>
                        )}
                        <span>{timeAgo(e.createdAt)} · {formatDateTime(e.createdAt)}</span>
                        {costs[e.id] && costs[e.id].snapshotCount > 0 && (
                          <span
                            className="flex items-center gap-0.5"
                            style={{ color: "#fde68a" }}
                            title={`~${costs[e.id].totalTokens} tokens (${costs[e.id].inputTokens} in / ${costs[e.id].outputTokens} out)${costs[e.id].model ? ` · ${costs[e.id].model}` : ""} · ${costs[e.id].snapshotCount} snapshot(s) na janela`}
                          >
                            <DollarSign className="w-2.5 h-2.5" />
                            {costs[e.id].cost < 0.0001
                              ? "<$0.0001"
                              : `~$${costs[e.id].cost.toFixed(4)}`}
                          </span>
                        )}
                        {isAcked && (
                          <span style={{ color: "#6ee7b7" }}>
                            ✓ visto em {formatDateTime(e.acknowledgedAt!)}
                          </span>
                        )}
                      </div>
                    </div>
                    {!isAcked && (
                      <button
                        onClick={() => void ackOne(e.id)}
                        disabled={busyAck !== null}
                        className="text-[11px] px-2 py-1 rounded disabled:opacity-50 shrink-0"
                        style={{
                          backgroundColor: "rgba(16,185,129,0.10)",
                          color: "#6ee7b7",
                          border: "1px solid rgba(16,185,129,0.3)",
                        }}
                      >
                        Marcar visto
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Diagnostic banner ──────────────────────────────────────────────────────
// Renders a compact strip with: modo atual, atividade WhatsApp das últimas 24h,
// total histórico de briefings, e um hint do "por que essa página pode estar
// vazia" (computado server-side). Tom adaptativo: verde quando tudo flui,
// amarelo quando há gap entre atividade e briefings, neutro caso contrário.

// ─── Thread view (chat bubbles) ─────────────────────────────────────────────
// Renderiza os briefings de um remetente como conversa: o resumo inbound vai
// numa bolha cinza à esquerda, e a resposta do bot (`botReply`) vai numa
// bolha verde à direita. Quando o briefing não tem `botReply`, a bolha do bot
// é substituída por uma nota italics ("(ignorado / sem resposta)") pra deixar
// óbvio que o agente decidiu não responder. Ordena cronologicamente ASC pra
// fluir como leitura natural de chat (mais antigo no topo).

function ThreadView({
  entries,
  costs,
}: {
  entries: BriefingEntry[];
  costs: Record<string, CostEntry>;
}) {
  const ordered = useMemo(() => [...entries].sort((a, b) => a.createdAt - b.createdAt), [entries]);

  return (
    <div className="p-4 space-y-3" style={{ backgroundColor: "rgba(0,0,0,0.15)" }}>
      {ordered.map((e, idx) => {
        const meta = URGENCY_META[e.urgency];
        const prev = idx > 0 ? ordered[idx - 1] : null;
        // Gap > 1h entre mensagens → divider com tempo decorrido (ajuda a
        // perceber "essa conversa foi de manhã, essa de noite").
        const gapMs = prev ? e.createdAt - prev.createdAt : 0;
        const showDivider = gapMs > 60 * 60 * 1000;
        const c = costs[e.id];
        return (
          <div key={e.id}>
            {showDivider && (
              <div className="flex items-center gap-2 my-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
                <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
                <span>
                  {Math.floor(gapMs / 3_600_000) >= 24
                    ? `${Math.floor(gapMs / 86_400_000)}d depois`
                    : `${Math.floor(gapMs / 3_600_000)}h depois`}
                </span>
                <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
              </div>
            )}

            {/* Inbound — bolha cinza à esquerda */}
            <div className="flex items-start gap-2 max-w-[80%]">
              <div
                className="rounded-2xl rounded-tl-sm px-3 py-2 text-[12px] space-y-1"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                <div className="flex items-center gap-1.5 text-[10px]" style={{ color: meta.color }}>
                  <span>{meta.icon}</span>
                  <span>{meta.label}</span>
                  {e.requiresFollowup && <span style={{ color: "#fbbf24" }}>· ↩ exige retorno</span>}
                </div>
                <div>{e.summary}</div>
                {e.rawExcerpt && (
                  <details className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    <summary className="cursor-pointer">trecho literal</summary>
                    <pre
                      className="mt-1 whitespace-pre-wrap p-1.5 rounded font-mono text-[10px]"
                      style={{ backgroundColor: "rgba(0,0,0,0.3)" }}
                    >
                      {e.rawExcerpt}
                    </pre>
                  </details>
                )}
                <div className="flex items-center gap-2 text-[9px]" style={{ color: "var(--text-muted)" }}>
                  <span>{formatDateTime(e.createdAt)}</span>
                  {c && c.snapshotCount > 0 && (
                    <span
                      style={{ color: "#fde68a" }}
                      title={`~${c.totalTokens} tokens${c.model ? ` · ${c.model}` : ""}`}
                    >
                      {c.cost < 0.0001 ? "<$0.0001" : `~$${c.cost.toFixed(4)}`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Outbound — bolha verde à direita, OU nota de "ignorado" */}
            <div className="flex items-start gap-2 max-w-[80%] ml-auto mt-1 justify-end">
              {e.botReply ? (
                <div
                  className="rounded-2xl rounded-tr-sm px-3 py-2 text-[12px]"
                  style={{
                    backgroundColor: "rgba(16,185,129,0.10)",
                    border: "1px solid rgba(16,185,129,0.3)",
                    color: "var(--text-primary)",
                  }}
                >
                  <div className="text-[10px] mb-0.5" style={{ color: "#6ee7b7" }}>
                    Bot respondeu
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{e.botReply}</div>
                  {e.actionTaken && (
                    <div className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
                      ação: {e.actionTaken}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="text-[11px] italic px-3 py-1.5 rounded-2xl rounded-tr-sm"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.2)",
                    border: "1px dashed var(--border)",
                    color: "var(--text-muted)",
                  }}
                >
                  {e.actionTaken
                    ? `(sem resposta — ${e.actionTaken})`
                    : "(sem resposta registrada)"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DiagnosticBanner({
  diag,
  totalBriefingsShown,
}: {
  diag: BriefingDiagnostics;
  totalBriefingsShown: number;
}) {
  const { mode, activity, briefings, hints } = diag;

  // Cor do banner reflete o "delta": atividade alta + briefings zerados =
  // amarelo (algo pra investigar). Tudo zero ou tudo fluindo = neutro/verde.
  const activeWithoutBriefings = activity.last24hCount > 0 && briefings.totalEver === 0;
  const passiveOrPairing =
    mode.operationMode === "passive" || mode.operationMode === "pairing";
  const healthy =
    !activeWithoutBriefings &&
    !passiveOrPairing &&
    briefings.totalEver > 0 &&
    totalBriefingsShown > 0;

  const tone = activeWithoutBriefings || passiveOrPairing ? "warn" : healthy ? "ok" : "info";
  const palette = {
    ok: {
      bg: "rgba(16,185,129,0.06)",
      border: "rgba(16,185,129,0.35)",
      color: "#6ee7b7",
      Icon: CheckCircle2,
    },
    warn: {
      bg: "rgba(234,179,8,0.06)",
      border: "rgba(234,179,8,0.35)",
      color: "#fbbf24",
      Icon: AlertTriangle,
    },
    info: {
      bg: "rgba(59,130,246,0.06)",
      border: "rgba(59,130,246,0.35)",
      color: "#93c5fd",
      Icon: Info,
    },
  }[tone];
  const Icon = palette.Icon;

  const lastActivityAgo = activity.lastTimestamp
    ? `${Math.max(
        1,
        Math.floor((Date.now() - new Date(activity.lastTimestamp).getTime()) / 60_000),
      )}min atrás`
    : "—";

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      <div className="flex items-center gap-2 flex-wrap text-[12px]" style={{ color: "var(--text-primary)" }}>
        <Icon className="w-4 h-4 shrink-0" style={{ color: palette.color }} />
        <span className="font-medium">{mode.label}</span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          (dmPolicy: <code>{mode.dmPolicy || "—"}</code>)
        </span>
        <span className="opacity-30">·</span>
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
          <strong>{activity.last24hCount}</strong>
          <span style={{ color: "var(--text-muted)" }}>
            evento(s) WhatsApp em 24h
          </span>
          {activity.lastTimestamp && (
            <span style={{ color: "var(--text-muted)" }}>· último {lastActivityAgo}</span>
          )}
        </span>
        <span className="opacity-30">·</span>
        <span>
          <strong>{briefings.totalEver}</strong>
          <span style={{ color: "var(--text-muted)" }}> briefing(s) histórico(s)</span>
          {briefings.pendingCount > 0 && (
            <span style={{ color: "#fbbf24" }}> · {briefings.pendingCount} pendente(s)</span>
          )}
        </span>
      </div>

      {hints.length > 0 && (
        <ul className="text-[11px] space-y-1" style={{ color: palette.color }}>
          {hints.map((h, i) => (
            <li key={i} className="leading-snug">
              {h}
            </li>
          ))}
        </ul>
      )}

      {activity.lastDescription && (
        <div className="text-[10px] pt-1 border-t" style={{ borderColor: palette.border, color: "var(--text-muted)" }}>
          <span className="opacity-70">última atividade:</span> {activity.lastDescription}
        </div>
      )}
    </div>
  );
}
