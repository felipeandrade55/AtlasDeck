"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";

interface Learning {
  id: string;
  agent_id: string | null;
  pattern: string;
  evidence: string | null;
  source: "approval" | "rejection" | "feedback_text" | "implicit_sentiment" | "manual";
  confidence: number;
  refuted: boolean;
  created_at: string;
  last_seen_at: string;
}

interface LearnerState {
  last_run_at: string;
  last_ingested_completed_at: string;
  total_ingested: number;
}

/**
 * Card on the /agents page that surfaces the preference model's current
 * state — "what Jarvis learned about you". Two affordances:
 *
 *   - Refute a learning (UI marks it `refuted=true`, then the
 *     orchestrator-injector skips it on the next MEMORY.md rewrite).
 *   - "Atualizar agora" button to trigger the Learner cron pass on demand
 *     (handy after batch-approving several tasks).
 *
 * Collapsed by default to keep the /agents header lean.
 */
export function LearningsTimeline() {
  const [open, setOpen] = useState(false);
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [state, setState] = useState<LearnerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRefuted, setShowRefuted] = useState(false);
  const [badgeCount, setBadgeCount] = useState<number | null>(null);

  // Load just the count on mount so the badge is accurate even when collapsed.
  useEffect(() => {
    fetch("/api/learnings?limit=1&count_only=1", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.total_active != null) setBadgeCount(d.total_active); })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const [lRes, sRes] = await Promise.all([
        fetch(`/api/learnings?limit=200${showRefuted ? "&include_refuted=1" : ""}`, {
          cache: "no-store",
        }),
        fetch("/api/learner/run", { method: "GET", cache: "no-store" }),
      ]);
      if (lRes.ok) {
        const data = await lRes.json();
        const list = Array.isArray(data.learnings) ? data.learnings : [];
        setLearnings(list);
        setBadgeCount(list.filter((l: Learning) => !l.refuted).length);
      }
      if (sRes.ok) {
        const data = await sRes.json();
        setState(data.state ?? null);
      }
    } catch {
      // best effort
    }
  }, [showRefuted]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const runNow = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/learner/run", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const refute = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await fetch("/api/learnings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const byAgent = groupByAgent(learnings);
  const displayCount = badgeCount ?? learnings.filter((l) => !l.refuted).length;

  return (
    <div
      className="rounded-xl"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-3 hover:bg-zinc-900/40 transition-colors rounded-t-xl"
        style={{ background: "none", border: "none", cursor: "pointer" }}
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-bold text-white">O que Jarvis aprendeu</span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
            {displayCount}
          </span>
          {state && (
            <span className="text-[10px] text-zinc-500">
              · última ingestão: {formatRelative(state.last_run_at)} · {state.total_ingested} tasks
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>

      {open && (
        <div className="p-3 pt-0 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>
          <div className="mt-3 px-2.5 py-2 rounded-lg text-[10px] text-zinc-400 leading-relaxed"
            style={{ backgroundColor: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.15)" }}>
            <span className="font-semibold text-purple-300">Como funciona:</span>{" "}
            Jarvis observa suas aprovações e rejeições de tasks e extrai padrões de preferência automaticamente (a cada hora).
            Quanto maior a barra colorida, maior a confiança no padrão — verde é alta, amarelo é média, cinza é baixa.
            Se um padrão estiver errado, clique em{" "}
            <span className="text-zinc-300">✕</span> para refutá-lo e ele deixa de influenciar os agentes.
            Use <span className="text-zinc-300">"Atualizar agora"</span> após aprovar/rejeitar várias tasks de uma vez.
          </div>
          <div className="flex flex-wrap gap-2 items-center pt-1">
            <button
              type="button"
              onClick={runNow}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded font-semibold flex items-center gap-1 disabled:opacity-50"
              style={{ backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}
            >
              <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
              Atualizar agora
            </button>
            <label className="flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showRefuted}
                onChange={(e) => setShowRefuted(e.target.checked)}
              />
              mostrar refutados
            </label>
            <span className="text-[10px] text-zinc-500 ml-auto">
              clique no ✕ pra refutar um aprendizado
            </span>
          </div>

          {byAgent.length === 0 && (
            <div className="text-center py-6 text-xs text-zinc-500">
              Sem aprendizados ainda. Aprove/rejeite tasks no Operator Chat ou na aba Live Mission
              pra começar a alimentar o modelo.
            </div>
          )}

          {byAgent.map((group) => (
            <div
              key={group.agent_id ?? "__global__"}
              className="rounded-lg p-2.5"
              style={{ backgroundColor: "rgba(0,0,0,0.30)", border: "1px solid var(--border)" }}
            >
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">
                {group.agent_id ? `🤖 ${group.agent_id}` : "🌐 global"} · {group.items.length} aprendizado(s)
              </div>
              <div className="space-y-1">
                {group.items.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-start gap-2 px-2 py-1.5 rounded"
                    style={{
                      backgroundColor: l.refuted ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${l.refuted ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
                      opacity: l.refuted ? 0.55 : 1,
                    }}
                  >
                    <ConfidenceBar value={l.confidence} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-white leading-snug">
                        {l.pattern}
                        {l.refuted && (
                          <span className="ml-2 text-[10px] text-red-300">(refutado)</span>
                        )}
                      </div>
                      <div className="text-[9px] text-zinc-500 mt-0.5 truncate">
                        src: {l.source} · evidência: {l.evidence ?? "—"} · {formatRelative(l.last_seen_at)}
                      </div>
                    </div>
                    {!l.refuted && (
                      <button
                        type="button"
                        onClick={() => refute(l.id)}
                        disabled={busy}
                        className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800"
                        style={{ background: "none", border: "none", cursor: "pointer" }}
                        aria-label="Refutar"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const color = pct > 0.66 ? "#22c55e" : pct > 0.33 ? "#eab308" : "#94a3b8";
  return (
    <div
      className="flex-shrink-0 w-1.5 h-8 rounded-full overflow-hidden mt-0.5"
      style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
      title={`confidence ${pct.toFixed(2)}`}
    >
      <div
        className="w-full transition-all"
        style={{
          height: `${pct * 100}%`,
          backgroundColor: color,
          marginTop: `${(1 - pct) * 100}%`,
        }}
      />
    </div>
  );
}

interface AgentGroup { agent_id: string | null; items: Learning[] }
function groupByAgent(learnings: Learning[]): AgentGroup[] {
  const map = new Map<string, Learning[]>();
  for (const l of learnings) {
    const key = l.agent_id ?? "__global__";
    const arr = map.get(key) ?? [];
    arr.push(l);
    map.set(key, arr);
  }
  return Array.from(map.entries())
    .map(([key, items]) => ({
      agent_id: key === "__global__" ? null : key,
      items: items.sort((a, b) => b.confidence - a.confidence),
    }))
    .sort((a, b) => (a.agent_id ?? "").localeCompare(b.agent_id ?? ""));
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t || t < 1000) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "agora";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m atrás`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h atrás`;
  return `${Math.floor(diff / 86_400_000)}d atrás`;
}
