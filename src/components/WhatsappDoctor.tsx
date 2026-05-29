"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Stethoscope,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
  Loader2,
  Send,
  RefreshCw,
  Power,
  Settings as SettingsIcon,
  Trash2,
  Wrench,
} from "lucide-react";

type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface FixHint {
  action:
    | "clear-webhook"
    | "drop-pending"
    | "restart-gateway"
    | "open-setup"
    | "runbook"
    | "retry"
    | "repair-config";
  label: string;
  accountId?: string;
  destructive?: boolean;
  runbook?: string[];
}

interface Check {
  id: string;
  category: "whatsapp" | "openclaw" | "config";
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: FixHint;
}

interface DiagnoseResponse {
  ok: boolean;
  timestamp: string;
  checks: Check[];
  testMessage: {
    attempted: boolean;
    sent: boolean;
    accountId?: string;
    sentTo?: string;
    error?: string;
  };
  summary: {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
    headline: string;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

const STATUS_META: Record<CheckStatus, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  pass: { icon: CheckCircle2, color: "#34d399", bg: "rgba(16,185,129,0.10)" },
  warn: { icon: AlertTriangle, color: "#facc15", bg: "rgba(250,204,21,0.10)" },
  fail: { icon: XCircle, color: "#fca5a5", bg: "rgba(248,113,113,0.10)" },
  skip: { icon: MinusCircle, color: "#94a3b8", bg: "rgba(148,163,184,0.10)" },
};

const CATEGORY_LABEL: Record<Check["category"], string> = {
  whatsapp: "WhatsApp",
  openclaw: "OpenClaw",
  config: "Configuração",
};

export function WhatsappDoctor({ open, onClose, onChanged }: Props) {
  const [data, setData] = useState<DiagnoseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<Array<{ id: string; ok: boolean; msg: string }>>([]);

  const runDiagnose = useCallback(async (sendTest: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/whatsapp/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendTest }),
      });
      const json = (await res.json()) as DiagnoseResponse | { error: string };
      if (!res.ok || "error" in json) {
        throw new Error(("error" in json && json.error) || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !data) {
      void runDiagnose(false);
    }
  }, [open, data, runDiagnose]);

  const applyFix = useCallback(
    async (check: Check) => {
      const fix = check.fix;
      if (!fix) return;
      setBusyAction(check.id);

      const log = (ok: boolean, msg: string) =>
        setActionLog((prev) => [...prev, { id: check.id, ok, msg }]);

      try {
        if (fix.action === "restart-gateway") {
          const res = await fetch("/api/recovery/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "gateway-restart" }),
          });
          const json = (await res.json()) as { success?: boolean; error?: string; output?: string };
          if (res.ok && json.success) {
            log(true, "Gateway reiniciado ✓ (aguarde alguns segundos)");
            setTimeout(() => void runDiagnose(false), 3000);
            onChanged?.();
          } else {
            log(false, json.error || "Falha ao reiniciar gateway");
          }
        } else if (fix.action === "repair-config") {
          const res = await fetch("/api/integrations/whatsapp/repair", { method: "POST" });
          const json = (await res.json()) as {
            ok?: boolean;
            error?: string;
            sweep?: { changedWhatsapp?: boolean; changedTelegram?: boolean };
            validate?: { ok?: boolean | null; output?: string };
          };
          if (res.ok && json.ok) {
            const moved: string[] = [];
            if (json.sweep?.changedWhatsapp) moved.push("WhatsApp limpo");
            if (json.sweep?.changedTelegram) moved.push("Telegram limpo");
            log(true, `Config reparado ✓ ${moved.length ? `(${moved.join(", ")})` : ""}`);
            setTimeout(() => void runDiagnose(false), 1500);
            onChanged?.();
          } else {
            log(false, json.error || json.validate?.output || "Reparo falhou — schema ainda inválido");
          }
        } else if (fix.action === "retry") {
          await runDiagnose(true);
        } else if (fix.action === "open-setup") {
          onClose();
        }
      } catch (e) {
        log(false, e instanceof Error ? e.message : String(e));
      } finally {
        setBusyAction(null);
      }
    },
    [onChanged, onClose, runDiagnose],
  );

  if (!open) return null;

  const headline = data?.summary?.headline ?? (loading ? "Diagnosticando…" : "");
  const headlineColor = !data
    ? "var(--text-muted)"
    : data.summary.fail > 0
      ? "#fca5a5"
      : data.summary.warn > 0
        ? "#facc15"
        : "#34d399";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] rounded-xl flex flex-col"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2">
            <Stethoscope className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2
              className="text-base font-semibold"
              style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
            >
              Doctor: WhatsApp + OpenClaw
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/5"
            style={{ color: "var(--text-secondary)" }}
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary bar + actions */}
        <div
          className="px-5 py-3 border-b flex flex-wrap items-center gap-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--text-muted)" }} />
            ) : (
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: headlineColor }}
              />
            )}
            <span className="text-sm font-medium" style={{ color: headlineColor }}>
              {headline}
            </span>
            {data && (
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                · {data.summary.pass} ok · {data.summary.warn} alerta · {data.summary.fail} crítico
                {data.summary.skip > 0 ? ` · ${data.summary.skip} pulado` : ""}
              </span>
            )}
          </div>

          <button
            onClick={() => void runDiagnose(false)}
            disabled={loading}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded hover:bg-white/5 disabled:opacity-50"
            style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Rediagnosticar
          </button>

          <button
            onClick={() => void runDiagnose(true)}
            disabled={loading}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded disabled:opacity-50"
            style={{
              backgroundColor: "rgba(139,92,246,0.20)",
              color: "#c4b5fd",
              border: "1px solid rgba(139,92,246,0.45)",
            }}
          >
            <Send className="w-3 h-3" />
            Mandar teste no WhatsApp
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div
              className="rounded-lg p-3 text-sm flex items-start gap-2"
              style={{
                backgroundColor: "rgba(248,113,113,0.10)",
                border: "1px solid rgba(248,113,113,0.35)",
                color: "#fca5a5",
              }}
            >
              <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium">Falha ao rodar o diagnóstico</div>
                <div className="text-xs mt-0.5 opacity-90">{error}</div>
              </div>
            </div>
          )}

          {/* Test message banner */}
          {data?.testMessage.attempted && (
            <div
              className="rounded-lg p-3 text-sm flex items-start gap-2"
              style={{
                backgroundColor: data.testMessage.sent
                  ? "rgba(16,185,129,0.10)"
                  : "rgba(248,113,113,0.10)",
                border: `1px solid ${
                  data.testMessage.sent
                    ? "rgba(16,185,129,0.35)"
                    : "rgba(248,113,113,0.35)"
                }`,
                color: data.testMessage.sent ? "#34d399" : "#fca5a5",
              }}
            >
              {data.testMessage.sent ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              )}
              <div>
                <div className="font-medium">
                  {data.testMessage.sent
                    ? `Mensagem de teste entregue a ${data.testMessage.sentTo}`
                    : "Mensagem de teste falhou"}
                </div>
                <div className="text-xs mt-0.5 opacity-90">
                  {data.testMessage.sent
                    ? "Confira se chegou no seu WhatsApp. Se não visualizou, revise se o chatId de destino está no formato DDI+DDD+número."
                    : data.testMessage.error}
                </div>
              </div>
            </div>
          )}

          {/* Action log */}
          {actionLog.length > 0 && (
            <div
              className="rounded-lg p-3"
              style={{
                backgroundColor: "rgba(59,130,246,0.08)",
                border: "1px solid rgba(59,130,246,0.30)",
              }}
            >
              <div className="text-xs font-semibold mb-1" style={{ color: "#93c5fd" }}>
                Ações executadas
              </div>
              <ul className="space-y-0.5">
                {actionLog.map((a, i) => (
                  <li
                    key={`${a.id}-${i}`}
                    className="text-xs"
                    style={{ color: a.ok ? "#86efac" : "#fca5a5" }}
                  >
                    {a.ok ? "✓" : "✗"} {a.msg}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Checks grouped by category */}
          {data && (["openclaw", "whatsapp", "config"] as const).map((cat) => {
            const items = data.checks.filter((c) => c.category === cat);
            if (items.length === 0) return null;
            return (
              <section key={cat}>
                <h3
                  className="text-[10px] font-bold uppercase tracking-wider mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  {CATEGORY_LABEL[cat]}
                </h3>
                <div className="space-y-1.5">
                  {items.map((c) => {
                    const meta = STATUS_META[c.status];
                    const Icon = meta.icon;
                    const fixIcon = fixIconFor(c.fix?.action);
                    return (
                      <div
                        key={c.id}
                        className="rounded-lg p-3 flex items-start gap-3"
                        style={{
                          backgroundColor: meta.bg,
                          border: `1px solid ${meta.color}33`,
                        }}
                      >
                        <Icon
                          className="w-4 h-4 mt-0.5 flex-shrink-0"
                          style={{ color: meta.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                            {c.label}
                          </div>
                          <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                            {c.detail}
                          </div>
                          {c.fix?.runbook && (
                            <ul className="text-[11px] mt-1.5 space-y-0.5" style={{ color: "var(--text-muted)" }}>
                              {c.fix.runbook.map((line, i) => (
                                <li key={i}>• {line}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        {c.fix && c.fix.action !== "runbook" && (
                          <button
                            onClick={() => void applyFix(c)}
                            disabled={busyAction === c.id}
                            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded flex-shrink-0 disabled:opacity-50"
                            style={{
                              backgroundColor: c.fix.destructive
                                ? "rgba(248,113,113,0.15)"
                                : "rgba(139,92,246,0.15)",
                              color: c.fix.destructive ? "#fca5a5" : "#c4b5fd",
                              border: `1px solid ${c.fix.destructive ? "rgba(248,113,113,0.40)" : "rgba(139,92,246,0.40)"}`,
                            }}
                            title={c.fix.label}
                          >
                            {busyAction === c.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              fixIcon && <fixIcon.Comp className="w-3 h-3" />
                            )}
                            {c.fix.label}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {/* Footer help */}
          {data && data.summary.fail > 0 && (
            <div
              className="rounded-lg p-3 text-xs"
              style={{
                backgroundColor: "rgba(250,204,21,0.08)",
                border: "1px solid rgba(250,204,21,0.30)",
                color: "var(--text-secondary)",
              }}
            >
              <strong style={{ color: "#facc15" }}>Roteiro sugerido:</strong>
              <ol className="list-decimal pl-5 mt-1 space-y-0.5">
                <li>Verifique se o token de acesso e número de telefone de origem estão corretos.</li>
                <li>Mande uma mensagem de teste para confirmar entrega de ponta a ponta.</li>
                <li>Se a mensagem sai mas o gateway não lê DMs, reinicie o gateway OpenClaw.</li>
              </ol>
            </div>
          )}

          {!data && !loading && !error && (
            <div className="text-center py-8 text-xs" style={{ color: "var(--text-muted)" }}>
              Clique em &quot;Rediagnosticar&quot; pra começar.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fixIconFor(action?: FixHint["action"]) {
  switch (action) {
    case "clear-webhook":
    case "drop-pending":
      return { Comp: Trash2 };
    case "restart-gateway":
      return { Comp: Power };
    case "open-setup":
      return { Comp: SettingsIcon };
    case "retry":
      return { Comp: RefreshCw };
    case "repair-config":
      return { Comp: Wrench };
    default:
      return null;
  }
}
