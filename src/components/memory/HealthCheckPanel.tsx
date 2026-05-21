"use client";

/**
 * UI counterpart of the smoke test script. Runs the same checks via
 * the /api/memory/health endpoint and shows results inline so a fresh
 * install can be verified with a click instead of an SSH session.
 */
import { useCallback, useState } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, MinusCircle, Loader2, PlayCircle } from "lucide-react";
import { useToast } from "@/components/Toast";

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  durationMs: number;
}

interface HealthResponse {
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; skip: number };
  durationMs: number;
  workspace: string;
}

interface Props {
  workspace: string;
}

const STATUS_ICON: Record<Status, React.ReactNode> = {
  ok: <CheckCircle2 size={16} style={{ color: "var(--success, #32D74B)" }} />,
  warn: <AlertTriangle size={16} style={{ color: "var(--warning, #FFD60A)" }} />,
  fail: <AlertCircle size={16} style={{ color: "var(--error, #FF453A)" }} />,
  skip: <MinusCircle size={16} style={{ color: "var(--text-muted)" }} />,
};

export function HealthCheckPanel({ workspace }: Props) {
  const toast = useToast();
  const [result, setResult] = useState<HealthResponse | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    try {
      setRunning(true);
      const res = await fetch(
        `/api/memory/health?workspace=${encodeURIComponent(workspace)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthResponse;
      setResult(data);
      if (data.summary.fail > 0) {
        toast.error(`${data.summary.fail} verificação(ões) falharam`);
      } else if (data.summary.warn > 0) {
        toast.info(`${data.summary.warn} aviso(s) — sistema ok, mas com pontos pra atenção`);
      } else {
        toast.success("Todas as verificações passaram");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao verificar");
    } finally {
      setRunning(false);
    }
  }, [workspace, toast]);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h3 style={sectionTitleStyle}>
            <PlayCircle size={14} /> Verificação de saúde do sistema
          </h3>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Roda a mesma bateria do <code>npm run smoke-test:memory</code>{" "}
            direto da interface. Útil em uma reinstalação para validar que
            tudo subiu corretamente.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={running}
          style={primaryButtonStyle}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
          {running ? "Verificando…" : "Verificar agora"}
        </button>
      </div>

      {result && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {result.summary.ok} ok · {result.summary.warn} aviso · {result.summary.fail} falha ·{" "}
            {result.summary.skip} skip — concluído em {result.durationMs}ms
          </div>
          {result.checks.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 10px",
                background: "var(--bg)",
                borderRadius: 6,
                border: "1px solid var(--border)",
              }}
            >
              <span style={{ paddingTop: 1 }}>{STATUS_ICON[c.status]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                  {c.label}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {c.detail}
                </div>
              </div>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{c.durationMs}ms</span>
            </div>
          ))}
        </div>
      )}

      {!result && !running && (
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
          Clique em <strong>Verificar agora</strong> para rodar todos os checks
          de uma vez.
        </p>
      )}
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--bg)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
