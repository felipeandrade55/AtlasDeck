"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Package, RefreshCw, X, XCircle } from "lucide-react";

type StepStatus = "ok" | "missing" | "error" | "skipped";

interface StepResult {
  key: string;
  label: string;
  status: StepStatus;
  detail: string;
  requires_filesystem?: boolean;
}

interface InstallReport {
  ready: boolean;
  steps: StepResult[];
  generated_at: string;
  base_url: string;
  openclaw_dir: string;
}

function statusIcon(status: StepStatus) {
  if (status === "ok") return <CheckCircle2 className="w-4 h-4" style={{ color: "var(--positive)" }} />;
  if (status === "error") return <XCircle className="w-4 h-4" style={{ color: "var(--negative)" }} />;
  if (status === "skipped") return <span style={{ color: "var(--text-muted)", fontSize: 14 }}>—</span>;
  return <AlertTriangle className="w-4 h-4" style={{ color: "var(--warning)" }} />;
}

export function InstallBanner() {
  const [report, setReport] = useState<InstallReport | null>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/install", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as InstallReport;
        setReport(data);
      }
    } catch {
      /* silent: banner just stays hidden */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runInstall = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/calendar/install", { method: "POST" });
      const data = (await res.json()) as InstallReport;
      setReport(data);
    } catch (err) {
      console.error("Install failed:", err);
    } finally {
      setRunning(false);
    }
  };

  if (!report || report.ready || dismissed) return null;

  const failingCount = report.steps.filter((s) => s.status !== "ok").length;

  return (
    <>
      <div
        style={{
          padding: "0.75rem 1rem",
          backgroundColor: "var(--warning-soft)",
          border: "1px solid var(--warning)",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", color: "var(--warning)", flex: 1 }}>
          <Package className="w-5 h-5" />
          <div>
            <div style={{ fontWeight: 600 }}>Integração com OpenClaw pendente</div>
            <div style={{ fontSize: "0.8rem", opacity: 0.9 }}>
              {failingCount} passo{failingCount > 1 ? "s" : ""} pendente{failingCount > 1 ? "s" : ""} para o
              OpenClaw conseguir mexer no seu calendário.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            onClick={() => setOpen(true)}
            className="btn-primary"
            style={{ padding: "0.4rem 0.85rem", fontSize: "0.82rem" }}
          >
            Instalar agora
          </button>
          <button
            onClick={() => setDismissed(true)}
            style={{ background: "none", border: "none", color: "var(--warning)", cursor: "pointer" }}
            title="Esconder até recarregar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !running && setOpen(false)} />
          <div
            className="relative w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl shadow-2xl mx-4"
            style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div
              className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between"
              style={{ backgroundColor: "var(--surface)", borderBottom: "1px solid var(--border)" }}
            >
              <h2
                className="text-xl font-semibold flex items-center gap-2"
                style={{ color: "var(--text-primary)" }}
              >
                <Package className="w-5 h-5" /> Instalar integração OpenClaw
              </h2>
              <button
                onClick={() => !running && setOpen(false)}
                disabled={running}
                style={{
                  color: "var(--text-muted)",
                  background: "none",
                  border: "none",
                  cursor: running ? "wait" : "pointer",
                }}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                Este botão registra a skill <code>atlasdeck-calendar</code> no OpenClaw, agenda os crons de
                lembretes/booking e garante que o token de serviço esteja configurado. Tudo é idempotente — pode
                rodar quantas vezes quiser.
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 0,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  overflow: "hidden",
                }}
              >
                {report.steps.map((step) => (
                  <div
                    key={step.key}
                    style={{
                      padding: "0.75rem 1rem",
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "center",
                      backgroundColor: "var(--surface-elevated)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    {running ? (
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--text-secondary)" }} />
                    ) : (
                      statusIcon(step.status)
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "0.88rem" }}>
                        {step.label}
                      </div>
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: step.status === "error" ? "var(--negative)" : "var(--text-secondary)",
                          wordBreak: "break-word",
                        }}
                      >
                        {step.detail}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                <div>
                  <b>OPENCLAW_DIR:</b> <code>{report.openclaw_dir}</code>
                </div>
                <div>
                  <b>Base URL:</b> <code>{report.base_url}</code>
                </div>
              </div>

              <div
                className="flex items-center justify-end gap-3 pt-2"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <button
                  type="button"
                  onClick={refresh}
                  className="btn-outline"
                  disabled={running}
                  style={{ fontSize: "0.82rem" }}
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Recarregar status
                </button>
                <button
                  type="button"
                  onClick={runInstall}
                  className="btn-primary"
                  disabled={running}
                  style={{ fontSize: "0.82rem" }}
                >
                  {running ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Instalando...
                    </>
                  ) : (
                    <>
                      <Package className="w-4 h-4" /> Executar instalação
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
