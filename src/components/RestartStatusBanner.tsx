"use client";

import { useState } from "react";
import { Loader2, Zap, AlertCircle, ChevronDown, ChevronUp, Terminal as TerminalIcon } from "lucide-react";
import type { ClientRestartResult } from "@/lib/restart-gateway-client";

interface Props {
  restarting: boolean;
  result: ClientRestartResult | null;
  /** Label shown in success message instead of generic "novo modelo já está ativo". */
  successHint?: string;
  /** Called by parent when user clicks "tentar novamente" on a failure. Optional. */
  onRetry?: () => void;
  /** Pre-formatted className for the wrapper element (so it fits both modal rows and full banners). */
  className?: string;
}

/**
 * Shared restart-status banner used by OpenClawDefaultsCard, TelegramSetupModal,
 * and /agents. The previous bespoke implementations hid `restartResult.output`
 * entirely, so when restart failed the user only saw "daemon ainda usa o
 * token antigo em memória" without any way to diagnose. This component
 * exposes the full output behind a collapsible "ver log" toggle so the user
 * can self-diagnose without leaving the screen.
 */
export function RestartStatusBanner({
  restarting,
  result,
  successHint = "novo modelo já está ativo",
  onRetry,
  className,
}: Props) {
  const [showLog, setShowLog] = useState(false);

  if (!restarting && !result) return null;

  const bg = restarting
    ? "rgba(139, 92, 246, 0.08)"
    : result?.success
      ? "rgba(16, 185, 129, 0.08)"
      : "rgba(239, 68, 68, 0.08)";
  const border = restarting
    ? "rgba(139, 92, 246, 0.3)"
    : result?.success
      ? "rgba(16, 185, 129, 0.3)"
      : "rgba(239, 68, 68, 0.3)";

  const log = result?.output || "";
  const hasLog = log.trim().length > 0;

  return (
    <div
      className={className || "px-5 py-2.5 border-t flex flex-col gap-2 text-xs"}
      style={{ backgroundColor: bg, borderColor: border }}
    >
      <div className="flex items-start gap-2">
        {restarting ? (
          <>
            <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" style={{ color: "#a78bfa" }} />
            <span style={{ color: "var(--text-primary)" }}>
              Reiniciando o gateway pra aplicar as mudanças…
            </span>
          </>
        ) : result?.success ? (
          <>
            <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#34d399" }} />
            <span style={{ color: "#34d399" }}>
              Gateway reiniciado em {(result.durationMs / 1000).toFixed(1)}s · {successHint}
            </span>
          </>
        ) : (
          <>
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#fca5a5" }} />
            <div className="flex-1 min-w-0">
              <div style={{ color: "#fca5a5" }}>
                Restart do gateway falhou — config foi salva, mas o daemon ainda usa os valores antigos em memória.
              </div>
              {result?.error && (
                <div className="mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {result.error.slice(0, 300)}
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                {hasLog && (
                  <button
                    type="button"
                    onClick={() => setShowLog((v) => !v)}
                    className="text-[11px] underline flex items-center gap-1"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <TerminalIcon className="w-3 h-3" />
                    {showLog ? "esconder log" : "ver log completo"}
                    {showLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="text-[11px] underline"
                    style={{ color: "#fca5a5" }}
                  >
                    tentar novamente
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {result && !result.success && showLog && hasLog && (
        <pre
          className="text-[10px] font-mono whitespace-pre-wrap overflow-auto p-2 rounded"
          style={{
            backgroundColor: "rgba(0,0,0,0.4)",
            color: "var(--text-primary)",
            maxHeight: 260,
            border: "1px solid var(--border)",
          }}
        >
          {log}
        </pre>
      )}
    </div>
  );
}
