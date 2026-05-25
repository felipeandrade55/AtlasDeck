"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Link2, Loader2, X, ChevronRight } from "lucide-react";
import { restartGatewayClient, getAutoRestartPref } from "@/lib/restart-gateway-client";

interface AgentLite {
  id: string;
  name: string;
}

interface NudgeState {
  /** Agents with detected resources but NO appendix in instructions.md */
  pending: Array<{ agentId: string; name: string; resourceSummary: string }>;
}

interface Props {
  agents: AgentLite[];
  /** Open the agent edit modal for a given id (so user can review before applying) */
  onOpenAgent?: (agentId: string) => void;
  /** Re-fetch agents after a successful auto-connect */
  onChanged?: () => void;
}

const DISMISS_KEY = "atlasdeck.memory-nudge-dismissed";

function dismissedFor(agentId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const arr: string[] = JSON.parse(raw);
    return Array.isArray(arr) && arr.includes(agentId);
  } catch {
    return false;
  }
}

function persistDismiss(agentId: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (!arr.includes(agentId)) arr.push(agentId);
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(arr));
  } catch {}
}

export function MemoryConnectNudge({ agents, onOpenAgent, onChanged }: Props) {
  const [state, setState] = useState<NudgeState>({ pending: [] });
  const [loading, setLoading] = useState(true);
  const [connectingAll, setConnectingAll] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [hidden, setHidden] = useState(false);

  /**
   * For each agent in the input list, call /api/agents/memory-connect (GET)
   * and check if `hasAnyResource && !isConnected && !dismissed`. Collect those.
   * Detection runs in parallel.
   */
  const detect = useCallback(async () => {
    if (!agents.length) {
      setState({ pending: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const results = await Promise.all(
        agents.map(async (a) => {
          try {
            const r = await fetch(`/api/agents/memory-connect?agentId=${encodeURIComponent(a.id)}`, {
              cache: "no-store",
            });
            if (!r.ok) return null;
            const json = await r.json();
            if (!json.hasAnyResource) return null;
            if (json.isConnected) return null;
            if (dismissedFor(a.id)) return null;
            const bits: string[] = [];
            if (json.shared?.memoryDb?.exists) bits.push(`${json.shared.memoryDb.entryCount ?? "?"} memórias`);
            if (json.shared?.knowledgeBase?.exists) bits.push(`${json.shared.knowledgeBase.sections?.length ?? 0} seções KB`);
            if (json.shared?.skills?.count > 0) bits.push(`${json.shared.skills.count} skills`);
            if (json.perAgent?.sessions?.count > 0) bits.push(`${json.perAgent.sessions.count} sessions`);
            return {
              agentId: a.id,
              name: a.name,
              resourceSummary: bits.join(" · "),
            };
          } catch {
            return null;
          }
        }),
      );
      setState({ pending: results.filter((x): x is NonNullable<typeof x> => x !== null) });
    } finally {
      setLoading(false);
    }
  }, [agents]);

  useEffect(() => {
    void detect();
  }, [detect]);

  const connectAll = async () => {
    setConnectingAll(true);
    setProgress({ current: 0, total: state.pending.length });
    try {
      for (let i = 0; i < state.pending.length; i++) {
        const p = state.pending[i];
        setProgress({ current: i + 1, total: state.pending.length });
        try {
          await fetch("/api/agents/memory-connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId: p.agentId }),
          });
        } catch {}
      }
      if (getAutoRestartPref()) {
        await restartGatewayClient();
      }
      await detect();
      onChanged?.();
    } finally {
      setConnectingAll(false);
      setProgress(null);
    }
  };

  const dismissAgent = (agentId: string) => {
    persistDismiss(agentId);
    setState((s) => ({ pending: s.pending.filter((p) => p.agentId !== agentId) }));
  };

  if (hidden || loading || state.pending.length === 0) return null;

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{
        backgroundColor: "rgba(139, 92, 246, 0.08)",
        border: "1px solid rgba(139, 92, 246, 0.35)",
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(139, 92, 246, 0.2)" }}
          >
            <Brain className="w-5 h-5" style={{ color: "#a78bfa" }} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-sm" style={{ color: "var(--text-primary)" }}>
              {state.pending.length === 1
                ? "Detectei memória custom não conectada"
                : `${state.pending.length} agentes têm memória custom não conectada`}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Encontrei <code className="text-[10px] bg-black/30 px-1 rounded">agent_memory.db</code>,{" "}
              <code className="text-[10px] bg-black/30 px-1 rounded">knowledge_base.json</code> e/ou{" "}
              <code className="text-[10px] bg-black/30 px-1 rounded">skills/</code> em{" "}
              <code className="text-[10px] bg-black/30 px-1 rounded">~/.openclaw/agents/</code>, mas o agente ainda não tem
              instruções pra consultar isso. <b>Sem conectar, o Jarvis responde sem usar essa memória.</b>
            </p>
          </div>
        </div>
        <button
          onClick={() => setHidden(true)}
          className="p-1 rounded hover:bg-white/5"
          aria-label="Esconder banner"
          title="Esconder por enquanto (não dismissa permanentemente)"
        >
          <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      <div className="space-y-1.5">
        {state.pending.map((p) => (
          <div
            key={p.agentId}
            className="flex items-center justify-between gap-3 p-2 rounded"
            style={{
              backgroundColor: "rgba(0,0,0,0.25)",
              border: "1px solid var(--border)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>
                  {p.name}
                </span>
                <code className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(255,255,255,0.05)", color: "var(--text-muted)" }}>
                  id: {p.agentId}
                </code>
              </div>
              <div className="text-[10px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                {p.resourceSummary}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onOpenAgent?.(p.agentId)}
                className="text-[11px] px-2 py-1 rounded flex items-center gap-1"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                Revisar
                <ChevronRight className="w-3 h-3" />
              </button>
              <button
                onClick={() => dismissAgent(p.agentId)}
                className="text-[10px] underline"
                style={{ color: "var(--text-muted)" }}
                title="Não mostrar de novo pra este agente"
              >
                ignorar
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          O apêndice é fence-marked (idempotente) — você pode desconectar depois sem perder o instructions.md original.
        </span>
        <button
          onClick={connectAll}
          disabled={connectingAll}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
          style={{
            backgroundColor: "rgba(139, 92, 246, 0.25)",
            color: "#c4b5fd",
            border: "1px solid rgba(139, 92, 246, 0.5)",
          }}
        >
          {connectingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
          {connectingAll
            ? progress
              ? `Conectando ${progress.current}/${progress.total}…`
              : "Conectando…"
            : state.pending.length === 1
              ? "Conectar agora"
              : `Conectar todos (${state.pending.length})`}
        </button>
      </div>
    </div>
  );
}
