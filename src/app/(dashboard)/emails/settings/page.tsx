"use client";

/**
 * Email accounts — connection management.
 *
 * Lists every IMAP/SMTP account configured in OpenClaw (read via the
 * gateway), with per-account actions: edit, re-test, delete, plus a
 * top-level "Add account" button. Mirrors the structure of
 * `IntegrationStatus` for Telegram.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Mail,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  PlugZap,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
  Loader2,
  RefreshCw,
  Edit,
  Inbox,
} from "lucide-react";
import { emailsClient, type EmailAccount } from "@/lib/emails-client";
import { ImapSetupModal } from "@/components/emails/ImapSetupModal";

export default function EmailSettingsPage() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [editing, setEditing] = useState<EmailAccount | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<Record<string, { kind: "ok" | "err"; text: string }>>(
    {},
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await emailsClient.listAccounts();
      setAccounts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onTest = async (id: string) => {
    setTestingId(id);
    setActionMsg((m) => ({ ...m, [id]: { kind: "ok", text: "testando…" } }));
    try {
      const res = await emailsClient.testAccount(id);
      const imapOk = res.imap?.ok ?? false;
      const smtpOk = res.smtp?.ok ?? false;
      if (imapOk && smtpOk) {
        setActionMsg((m) => ({ ...m, [id]: { kind: "ok", text: "IMAP e SMTP ok" } }));
      } else {
        const parts: string[] = [];
        if (!imapOk) parts.push(`IMAP: ${res.imap?.error || "falhou"}`);
        if (!smtpOk) parts.push(`SMTP: ${res.smtp?.error || "falhou"}`);
        setActionMsg((m) => ({ ...m, [id]: { kind: "err", text: parts.join(" · ") } }));
      }
      await load();
    } catch (e) {
      setActionMsg((m) => ({
        ...m,
        [id]: { kind: "err", text: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Remover conta "${id}"? As credenciais serão apagadas de openclaw.json.`)) return;
    try {
      await emailsClient.deleteAccount(id);
      await load();
    } catch (e) {
      setActionMsg((m) => ({
        ...m,
        [id]: { kind: "err", text: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  return (
    <div style={{ padding: "16px 24px 40px", maxWidth: 960, marginInline: "auto" }}>
      <div className="flex items-center gap-2 mb-2">
        <Link
          href="/emails"
          className="flex items-center gap-1 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <ArrowLeft className="w-3 h-3" /> Voltar para inbox
        </Link>
      </div>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <SettingsIcon className="w-6 h-6" style={{ color: "var(--accent)" }} />
          <h1
            className="text-2xl font-bold"
            style={{
              fontFamily: "var(--font-heading)",
              color: "var(--text-primary)",
              letterSpacing: "-0.5px",
            }}
          >
            Contas de e-mail
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </button>
          <button
            onClick={() => {
              setEditing(null);
              setSetupOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg"
            style={{
              backgroundColor: "rgba(139,92,246,0.2)",
              color: "#c4b5fd",
              border: "1px solid rgba(139,92,246,0.4)",
            }}
          >
            <Plus className="w-4 h-4" /> Adicionar conta
          </button>
        </div>
      </div>

      <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
        Cada conta vive em <code>openclaw.json</code> (no servidor onde o OpenClaw roda) sob
        <code> channels.email.accounts</code>. O AtlasDeck conversa com a skill IMAP/SMTP do
        OpenClaw via gateway HTTP — credenciais nunca passam pelo cache do navegador.
      </p>

      {error && (
        <div
          className="rounded-lg p-3 text-sm mb-4 flex items-start gap-2"
          style={{
            backgroundColor: "rgba(239,68,68,0.08)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.3)",
          }}
        >
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Falha ao consultar contas</div>
            <div className="text-xs mt-1">{error}</div>
          </div>
        </div>
      )}

      {loading && accounts.length === 0 && (
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      )}

      {!loading && accounts.length === 0 && !error && (
        <div
          className="rounded-xl p-10 text-center"
          style={{ backgroundColor: "var(--card)", border: "1px dashed var(--border)" }}
        >
          <Mail className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
          <h3 className="text-lg font-medium mb-1" style={{ color: "var(--text-primary)" }}>
            Nenhuma conta configurada
          </h3>
          <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
            Clique em &quot;Adicionar conta&quot; para conectar sua primeira caixa de entrada.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {accounts.map((a) => {
          const msg = actionMsg[a.id];
          const isConnected = a.status === "configured";
          const hasIssues = !!a.lastError || (a.issues?.length ?? 0) > 0;
          return (
            <div
              key={a.id}
              className="rounded-xl p-4"
              style={{
                backgroundColor: "var(--card)",
                border: `1px solid ${hasIssues ? "rgba(234,179,8,0.4)" : "var(--border)"}`,
              }}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className="p-2 rounded-lg"
                    style={{ backgroundColor: "rgba(139,92,246,0.1)" }}
                  >
                    <Mail className="w-5 h-5" style={{ color: "var(--accent)" }} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="font-medium text-sm"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {a.name || a.emailAddress}
                      </span>
                      <span
                        className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.05)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {a.id}
                      </span>
                      {isConnected ? (
                        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: "rgba(16,185,129,0.1)",
                            color: "#6ee7b7",
                            border: "1px solid rgba(16,185,129,0.3)",
                          }}
                        >
                          <CheckCircle2 className="w-3 h-3" /> Conectado
                        </span>
                      ) : a.status === "error" ? (
                        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: "rgba(239,68,68,0.1)",
                            color: "#fca5a5",
                            border: "1px solid rgba(239,68,68,0.3)",
                          }}
                        >
                          <XCircle className="w-3 h-3" /> Erro
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: "rgba(234,179,8,0.1)",
                            color: "#fde047",
                            border: "1px solid rgba(234,179,8,0.3)",
                          }}
                        >
                          <AlertTriangle className="w-3 h-3" /> Não testado
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                      {a.emailAddress}
                    </div>
                    <div className="text-[10px] mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: "var(--text-muted)" }}>
                      {a.imap && (
                        <span>
                          IMAP: <code>{a.imap.host}:{a.imap.port}</code> {a.imap.tls ? "TLS" : "plain"}
                        </span>
                      )}
                      {a.smtp && (
                        <span>
                          SMTP: <code>{a.smtp.host}:{a.smtp.port}</code> {a.smtp.tls ? "TLS" : "plain"}
                        </span>
                      )}
                      {a.lastSyncAt && (
                        <span>Último sync: {new Date(a.lastSyncAt).toLocaleString("pt-BR")}</span>
                      )}
                      {typeof a.unreadCount === "number" && (
                        <span className="flex items-center gap-0.5">
                          <Inbox className="w-2.5 h-2.5" /> {a.unreadCount} não lidos
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => onTest(a.id)}
                    disabled={testingId === a.id}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded disabled:opacity-50"
                    style={{
                      backgroundColor: "rgba(16,185,129,0.1)",
                      color: "#6ee7b7",
                      border: "1px solid rgba(16,185,129,0.3)",
                    }}
                  >
                    {testingId === a.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <PlugZap className="w-3 h-3" />
                    )}
                    Testar
                  </button>
                  <button
                    onClick={() => {
                      setEditing(a);
                      setSetupOpen(true);
                    }}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded"
                    style={{
                      backgroundColor: "rgba(139,92,246,0.1)",
                      color: "#c4b5fd",
                      border: "1px solid rgba(139,92,246,0.3)",
                    }}
                  >
                    <Edit className="w-3 h-3" /> Editar
                  </button>
                  <button
                    onClick={() => onDelete(a.id)}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded"
                    style={{
                      backgroundColor: "rgba(239,68,68,0.08)",
                      color: "#fca5a5",
                      border: "1px solid rgba(239,68,68,0.3)",
                    }}
                  >
                    <Trash2 className="w-3 h-3" /> Remover
                  </button>
                </div>
              </div>

              {(a.lastError || (a.issues && a.issues.length > 0)) && (
                <ul className="text-[11px] mt-3 space-y-0.5 list-disc list-inside" style={{ color: "#fde047" }}>
                  {a.lastError && <li>{a.lastError}</li>}
                  {a.issues?.map((iss, i) => <li key={i}>{iss}</li>)}
                </ul>
              )}

              {msg && (
                <div
                  className="text-[11px] mt-3"
                  style={{ color: msg.kind === "ok" ? "#34d399" : "#fca5a5" }}
                >
                  {msg.text}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ImapSetupModal
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          setEditing(null);
        }}
        editing={editing}
        onSaved={() => void load()}
      />
    </div>
  );
}
