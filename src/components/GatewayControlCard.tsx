"use client";

import { useCallback, useState } from "react";
import { RefreshCw, Zap, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Single, canonical place to restart the OpenClaw gateway. Replaces the
 * 8 scattered restart buttons that lived across RecoveryPanel,
 * GatewayDiagnoseCard, MemoryMcpCard and QuickActions — which confused
 * the user into not knowing which one actually reloads the agent's tools.
 *
 * Two actions, in plain language:
 *   1. Reiniciar (normal)  → soft restart / hot reload. For config changes.
 *      Keeps conversations and the MCP tool processes alive.
 *   2. Reiniciar forçado   → hard stop + start. Recreates the MCP server
 *      child processes, so NEW tools (delegação, etc.) finally load. This
 *      is the one to use after a deploy that changed the agent's tools.
 */

type Phase = "idle" | "soft" | "hard";

interface Banner {
  kind: "info" | "success" | "warn" | "error";
  text: string;
  detail?: string;
}

const BANNER_STYLE: Record<Banner["kind"], { bg: string; border: string; color: string }> = {
  info: { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.35)", color: "#93c5fd" },
  success: { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.35)", color: "#86efac" },
  warn: { bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.35)", color: "#fde047" },
  error: { bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.35)", color: "#fca5a5" },
};

export function GatewayControlCard() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [banner, setBanner] = useState<Banner | null>(null);

  const softRestart = useCallback(async () => {
    setPhase("soft");
    setBanner({ kind: "info", text: "Reiniciando o gateway (normal)…" });
    try {
      const res = await fetch("/api/recovery/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gateway-restart" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        ok?: boolean;
        output?: string;
        error?: string;
      };
      const ok = json.success ?? json.ok ?? res.ok;
      setBanner({
        kind: ok ? "success" : "warn",
        text: ok
          ? "Gateway reiniciado. Mudanças de configuração aplicadas."
          : "O reinício teve problemas — tente o forçado abaixo.",
        detail: json.error || json.output || undefined,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: "Falha ao reiniciar o gateway.",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPhase("idle");
    }
  }, []);

  const hardRestart = useCallback(async () => {
    if (
      !window.confirm(
        "Reinício FORÇADO do gateway (stop + start completo).\n\n" +
          "É isto que recarrega as ferramentas novas do Jarvis (delegação, etc.). " +
          "Interrompe conversas em andamento por ~5 segundos.\n\n" +
          "Depois, abra uma conversa NOVA no Telegram/chat para o Jarvis ler as ferramentas atualizadas.\n\n" +
          "Continuar?",
      )
    ) {
      return;
    }
    setPhase("hard");
    setBanner({ kind: "info", text: "Reinício forçado (stop + start, recarrega ferramentas)…" });
    try {
      const res = await fetch("/api/openclaw/memory-mcp/full-restart", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        strategy?: string | null;
        summary?: string;
        hint?: string;
      };
      const ok = json.ok ?? res.ok;
      setBanner({
        kind: ok ? "success" : "warn",
        text: ok
          ? "Gateway recriado. Agora abra uma conversa NOVA para o Jarvis carregar as ferramentas atualizadas (delegação, etc.)."
          : `O reinício forçado falhou: ${json.summary ?? "erro desconhecido"}`,
        detail: json.strategy ? `Estratégia: ${json.strategy}. ${json.hint ?? ""}` : json.summary,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: "Falha no reinício forçado.",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPhase("idle");
    }
  }, []);

  const busy = phase !== "idle";

  return (
    <div
      className="rounded-xl p-4 md:p-6"
      style={{ backgroundColor: "rgba(26,26,26,0.5)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <RefreshCw size={18} style={{ color: "var(--text)" }} />
        <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          Controle do Gateway
        </h3>
      </div>
      <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
        Um lugar só para reiniciar o motor do Jarvis (OpenClaw). Use o normal no dia a dia; use o
        forçado quando o Jarvis ganhar ferramentas novas e precisar recarregá-las.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Normal restart */}
        <div
          className="rounded-lg p-4 flex flex-col"
          style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw size={15} style={{ color: "#93c5fd" }} />
            <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
              Reiniciar (normal)
            </span>
          </div>
          <p className="text-xs mb-3 flex-1" style={{ color: "var(--text-muted)" }}>
            Aplica mudanças de configuração. Mantém as conversas vivas. Rápido e seguro para o dia a
            dia.
          </p>
          <button
            onClick={softRestart}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
            style={{ backgroundColor: "rgba(59,130,246,0.15)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.35)" }}
          >
            {phase === "soft" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {phase === "soft" ? "Reiniciando…" : "Reiniciar normal"}
          </button>
        </div>

        {/* Forced/hard restart */}
        <div
          className="rounded-lg p-4 flex flex-col"
          style={{ backgroundColor: "rgba(0,0,0,0.25)", border: "1px solid rgba(234,179,8,0.35)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Zap size={15} style={{ color: "#fde047" }} />
            <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
              Reiniciar forçado
            </span>
          </div>
          <p className="text-xs mb-3 flex-1" style={{ color: "var(--text-muted)" }}>
            Recria o processo do Jarvis do zero e <strong>recarrega as ferramentas novas</strong>{" "}
            (delegação, etc.). Use depois de uma atualização. Interrompe conversas por ~5s.
          </p>
          <button
            onClick={hardRestart}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
            style={{ backgroundColor: "rgba(234,179,8,0.15)", color: "#fde047", border: "1px solid rgba(234,179,8,0.45)" }}
          >
            {phase === "hard" ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
            {phase === "hard" ? "Reiniciando…" : "Reiniciar forçado"}
          </button>
        </div>
      </div>

      {banner && (
        <div
          className="mt-4 rounded-lg p-3 flex items-start gap-2"
          style={{
            backgroundColor: BANNER_STYLE[banner.kind].bg,
            border: `1px solid ${BANNER_STYLE[banner.kind].border}`,
          }}
        >
          {banner.kind === "success" ? (
            <CheckCircle2 size={16} style={{ color: BANNER_STYLE[banner.kind].color, marginTop: 1, flexShrink: 0 }} />
          ) : banner.kind === "error" || banner.kind === "warn" ? (
            <AlertTriangle size={16} style={{ color: BANNER_STYLE[banner.kind].color, marginTop: 1, flexShrink: 0 }} />
          ) : (
            <Loader2 size={16} className="animate-spin" style={{ color: BANNER_STYLE[banner.kind].color, marginTop: 1, flexShrink: 0 }} />
          )}
          <div className="min-w-0">
            <p className="text-sm" style={{ color: BANNER_STYLE[banner.kind].color }}>
              {banner.text}
            </p>
            {banner.detail && (
              <p className="text-xs mt-0.5 break-words" style={{ color: "var(--text-muted)" }}>
                {banner.detail}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
