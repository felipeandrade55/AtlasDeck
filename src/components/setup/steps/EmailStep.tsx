"use client";

/**
 * Wizard step: optionally connect one or more IMAP accounts to the
 * OpenClaw email skill so the inbox in /emails has data on first load.
 *
 * The step can be skipped — emails are not a hard requirement for the
 * dashboard to work. Skipping persists a flag so the wizard won't loop
 * back here on future restarts. Adding any account also counts as done.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Mail,
  Plus,
  Loader2,
  AlertTriangle,
  SkipForward,
  ArrowRight,
  XCircle,
} from "lucide-react";
import type { SetupStatus } from "../SetupStepper";
import { ImapSetupModal } from "@/components/emails/ImapSetupModal";
import { emailsClient, type EmailAccount } from "@/lib/emails-client";

interface Props {
  status: SetupStatus;
  onAdvance: () => void;
}

export function EmailStep({ status, onAdvance }: Props) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setGatewayError(null);
    try {
      const list = await emailsClient.listAccounts();
      setAccounts(list);
    } catch (e) {
      setGatewayError(e instanceof Error ? e.message : String(e));
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const skip = async () => {
    setSkipping(true);
    try {
      await fetch("/api/setup/email/skip", { method: "POST" });
      onAdvance();
    } catch (e) {
      setGatewayError(e instanceof Error ? e.message : String(e));
    } finally {
      setSkipping(false);
    }
  };

  // Auto-advance shortly after the user adds their first account
  useEffect(() => {
    if (accounts.length > 0 && !loading && !status.setup.completedAt) {
      // small delay so they see the green confirmation
      const t = setTimeout(onAdvance, 1500);
      return () => clearTimeout(t);
    }
  }, [accounts.length, loading, status.setup.completedAt, onAdvance]);

  const hasAccounts = accounts.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Conectar caixa(s) de e-mail
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          Opcional. Adicione contas IMAP/SMTP que o OpenClaw vai monitorar e que aparecem
          na página <code>/emails</code>. Você pode adicionar mais depois em{" "}
          <strong>E-mails → Contas</strong>. Pular agora não bloqueia nada.
        </p>
      </div>

      {hasAccounts && (
        <div
          style={{
            padding: "12px 14px",
            background: "rgba(50,215,75,0.1)",
            border: "1px solid var(--success, #32D74B)",
            borderRadius: 10,
            fontSize: 13.5,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <CheckCircle2 size={18} style={{ color: "var(--success, #32D74B)" }} />
          <div style={{ flex: 1 }}>
            <strong>
              {accounts.length === 1
                ? "1 conta conectada"
                : `${accounts.length} contas conectadas`}
            </strong>{" "}
            — pronto para receber e-mails. Avançando…
          </div>
        </div>
      )}

      {gatewayError && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(234,179,8,0.08)",
            border: "1px solid rgba(234,179,8,0.4)",
            borderRadius: 10,
            color: "#fde047",
            fontSize: 13,
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600 }}>Falha ao listar contas</div>
            <div style={{ fontSize: 12, marginTop: 4, color: "var(--text-secondary)" }}>
              {gatewayError}
            </div>
          </div>
        </div>
      )}

      {!loading && !hasAccounts && !gatewayError && (
        <div
          style={{
            padding: "16px",
            background: "var(--bg)",
            border: "1px dashed var(--border)",
            borderRadius: 12,
            textAlign: "center",
          }}
        >
          <Mail size={28} style={{ color: "var(--text-muted)", margin: "0 auto 8px" }} />
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
            Nenhuma conta configurada ainda.
          </div>
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            style={primaryBtn}
          >
            <Plus size={14} /> Conectar conta de e-mail
          </button>
        </div>
      )}

      {loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <Loader2 size={14} className="spin" /> Consultando o gateway…
        </div>
      )}

      {hasAccounts && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {accounts.map((a) => (
            <li
              key={a.id}
              style={{
                padding: "8px 12px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--text-primary)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {a.status === "configured" ? (
                <CheckCircle2 size={14} style={{ color: "var(--success, #32D74B)" }} />
              ) : a.status === "error" ? (
                <XCircle size={14} style={{ color: "var(--danger, #FF3B30)" }} />
              ) : (
                <AlertTriangle size={14} style={{ color: "#fde047" }} />
              )}
              <span style={{ flex: 1 }}>
                <strong>{a.name || a.emailAddress}</strong>
                <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                  {a.emailAddress}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!hasAccounts && (
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            style={primaryBtn}
          >
            <Plus size={14} /> Adicionar conta
          </button>
        )}
        {hasAccounts && (
          <button type="button" onClick={() => setSetupOpen(true)} style={ghostBtn}>
            <Plus size={14} /> Adicionar mais uma
          </button>
        )}
        {hasAccounts && (
          <button type="button" onClick={onAdvance} style={primaryBtn}>
            <ArrowRight size={14} /> Avançar
          </button>
        )}
        {!hasAccounts && (
          <button
            type="button"
            onClick={skip}
            disabled={skipping}
            style={ghostBtn}
            title="Pular este passo — você pode adicionar contas depois em E-mails → Contas"
          >
            {skipping ? <Loader2 size={14} className="spin" /> : <SkipForward size={14} />}
            Pular por enquanto
          </button>
        )}
      </div>

      <ImapSetupModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSaved={() => {
          setSetupOpen(false);
          void load();
        }}
      />
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 16px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--bg)",
  border: "none",
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "9px 14px",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  fontSize: 12.5,
  cursor: "pointer",
};
