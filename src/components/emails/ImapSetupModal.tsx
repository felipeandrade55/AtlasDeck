"use client";

/**
 * Add or edit an IMAP/SMTP account.
 *
 * Reused in three places: /emails/settings (account list), the welcome
 * wizard email step, and the "Add account" button on the inbox. Same
 * form, same submit pipeline — every save goes through the
 * /api/integrations/email/accounts proxy to the OpenClaw gateway.
 *
 * The modal supports a "Test connection" button that runs IMAP + SMTP
 * checks before saving — mirrors the UX of TelegramSetupModal where the
 * user can validate fresh credentials before persisting them.
 */
import { useEffect, useState } from "react";
import {
  X,
  Mail,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  XCircle,
  Save,
  PlugZap,
} from "lucide-react";
import { emailsClient, type AccountInput, type EmailAccount } from "@/lib/emails-client";

const PRESETS: Array<{
  label: string;
  match: (email: string) => boolean;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
  helpUrl?: string;
  hint?: string;
}> = [
  {
    label: "Gmail",
    match: (e) => /@gmail\.com$/i.test(e) || /@googlemail\.com$/i.test(e),
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 465, tls: true },
    helpUrl: "https://support.google.com/accounts/answer/185833",
    hint: "Gmail exige App Password (2FA → Senhas de App).",
  },
  {
    label: "Outlook / Hotmail / Office 365",
    match: (e) => /@(outlook|hotmail|live|office365)\./i.test(e),
    imap: { host: "outlook.office365.com", port: 993, tls: true },
    smtp: { host: "smtp.office365.com", port: 587, tls: true },
    hint: "Para contas pessoais Microsoft pode ser necessário ativar IMAP nas configurações.",
  },
  {
    label: "Yahoo",
    match: (e) => /@(yahoo|ymail)\./i.test(e),
    imap: { host: "imap.mail.yahoo.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, tls: true },
    hint: "Yahoo exige App Password.",
  },
  {
    label: "iCloud",
    match: (e) => /@(icloud|me|mac)\.com$/i.test(e),
    imap: { host: "imap.mail.me.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.me.com", port: 587, tls: true },
    hint: "iCloud exige senha específica (appleid.apple.com → Senhas específicas para app).",
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Existing account being edited; null when creating new. */
  editing?: EmailAccount | null;
  /** Notify parent so it can refresh its account list. */
  onSaved?: (account: EmailAccount) => void;
}

interface DraftState {
  id: string;
  name: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpSameAsImap: boolean;
}

function emptyDraft(): DraftState {
  return {
    id: "",
    name: "",
    emailAddress: "",
    imapHost: "",
    imapPort: 993,
    imapTls: true,
    imapUser: "",
    imapPassword: "",
    smtpHost: "",
    smtpPort: 465,
    smtpTls: true,
    smtpUser: "",
    smtpPassword: "",
    smtpSameAsImap: true,
  };
}

function suggestIdFromEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "account";
}

export function ImapSetupModal({ open, onClose, editing, onSaved }: Props) {
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [showImapPwd, setShowImapPwd] = useState(false);
  const [showSmtpPwd, setShowSmtpPwd] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    imap?: { ok: boolean; error?: string };
    smtp?: { ok: boolean; error?: string };
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [autoDetected, setAutoDetected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setTestResult(null);
    setShowImapPwd(false);
    setShowSmtpPwd(false);
    if (editing) {
      setDraft({
        id: editing.id,
        name: editing.name ?? "",
        emailAddress: editing.emailAddress ?? "",
        imapHost: editing.imap?.host ?? "",
        imapPort: editing.imap?.port ?? 993,
        imapTls: editing.imap?.tls ?? true,
        imapUser: editing.imap?.user ?? editing.emailAddress ?? "",
        imapPassword: "",
        smtpHost: editing.smtp?.host ?? "",
        smtpPort: editing.smtp?.port ?? 465,
        smtpTls: editing.smtp?.tls ?? true,
        smtpUser: editing.smtp?.user ?? editing.emailAddress ?? "",
        smtpPassword: "",
        smtpSameAsImap:
          (editing.smtp?.user ?? "") === (editing.imap?.user ?? "") &&
          (editing.smtp?.host ?? "") !== "",
      });
      setAutoDetected(null);
    } else {
      setDraft(emptyDraft());
      setAutoDetected(null);
    }
  }, [open, editing]);

  const update = (patch: Partial<DraftState>) => setDraft((d) => ({ ...d, ...patch }));

  const applyPreset = (email: string) => {
    const preset = PRESETS.find((p) => p.match(email));
    if (!preset) {
      setAutoDetected(null);
      return;
    }
    setAutoDetected(`${preset.label}${preset.hint ? ` — ${preset.hint}` : ""}`);
    update({
      imapHost: preset.imap.host,
      imapPort: preset.imap.port,
      imapTls: preset.imap.tls,
      imapUser: email,
      smtpHost: preset.smtp.host,
      smtpPort: preset.smtp.port,
      smtpTls: preset.smtp.tls,
      smtpUser: email,
    });
  };

  const handleEmailBlur = () => {
    if (!draft.id && draft.emailAddress) {
      update({ id: suggestIdFromEmail(draft.emailAddress) });
    }
    if (!draft.imapHost && draft.emailAddress) {
      applyPreset(draft.emailAddress);
    }
  };

  const buildPayload = (): AccountInput => {
    const smtpUser = draft.smtpSameAsImap ? draft.imapUser : draft.smtpUser;
    const smtpPassword = draft.smtpSameAsImap ? draft.imapPassword : draft.smtpPassword;
    return {
      id: draft.id.trim(),
      name: draft.name.trim() || undefined,
      emailAddress: draft.emailAddress.trim(),
      imap: {
        host: draft.imapHost.trim(),
        port: Number(draft.imapPort),
        tls: draft.imapTls,
        user: draft.imapUser.trim() || draft.emailAddress.trim(),
        password: draft.imapPassword,
      },
      smtp: {
        host: draft.smtpHost.trim(),
        port: Number(draft.smtpPort),
        tls: draft.smtpTls,
        user: smtpUser.trim() || draft.emailAddress.trim(),
        password: smtpPassword,
      },
    };
  };

  const validate = (): string | null => {
    if (!draft.id.trim()) return "ID da conta é obrigatório (ex: trabalho, pessoal).";
    if (!/^[a-z0-9_-]{1,32}$/i.test(draft.id.trim())) {
      return "ID só pode conter letras, números, '-' e '_' (até 32 chars).";
    }
    if (!draft.emailAddress.trim() || !/.+@.+\..+/.test(draft.emailAddress)) {
      return "E-mail inválido.";
    }
    if (!draft.imapHost.trim()) return "Servidor IMAP é obrigatório.";
    if (!draft.smtpHost.trim() && !draft.smtpSameAsImap) return "Servidor SMTP é obrigatório.";
    // For a brand-new account we need at least IMAP password; on edit it can be left blank to keep existing
    if (!editing && !draft.imapPassword) return "Senha IMAP é obrigatória.";
    return null;
  };

  const onTest = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setTestResult(null);
    setTesting(true);
    try {
      const payload = buildPayload();
      // Use accountId endpoint when editing (server tests credentials in-place),
      // or POST to /accounts when creating-but-not-saving with action=test via
      // body flag. The gateway is expected to accept a fresh payload either way.
      const res = await emailsClient.testAccount(payload.id || "draft", payload);
      setTestResult({ imap: res.imap, smtp: res.smtp });
      if (!res.ok) {
        setErr("Pelo menos um teste falhou — veja detalhes abaixo.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setSaving(true);
    try {
      const payload = buildPayload();
      const saved = editing
        ? await emailsClient.patchAccount(editing.id, payload)
        : await emailsClient.addAccount(payload);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.65)" }}
      onClick={onClose}
    >
      <div
        className="rounded-xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              {editing ? `Editar conta — ${editing.id}` : "Conectar conta de e-mail"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg"
            style={{ color: "var(--text-secondary)" }}
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-auto px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-xs space-y-1">
              <span style={{ color: "var(--text-secondary)" }}>ID interno</span>
              <input
                value={draft.id}
                onChange={(e) => update({ id: e.target.value.trim() })}
                placeholder="ex: trabalho"
                disabled={!!editing}
                className="w-full rounded px-2 py-1.5 text-sm font-mono disabled:opacity-60"
                style={{
                  backgroundColor: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              />
            </label>
            <label className="block text-xs space-y-1">
              <span style={{ color: "var(--text-secondary)" }}>Nome (opcional)</span>
              <input
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="ex: E-mail Corporativo"
                className="w-full rounded px-2 py-1.5 text-sm"
                style={{
                  backgroundColor: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              />
            </label>
          </div>

          <label className="block text-xs space-y-1">
            <span style={{ color: "var(--text-secondary)" }}>Endereço de e-mail</span>
            <input
              value={draft.emailAddress}
              onChange={(e) => update({ emailAddress: e.target.value, imapUser: e.target.value })}
              onBlur={handleEmailBlur}
              placeholder="voce@empresa.com"
              type="email"
              className="w-full rounded px-2 py-1.5 text-sm"
              style={{
                backgroundColor: "rgba(0,0,0,0.3)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
              }}
            />
            {autoDetected && (
              <span className="block text-[10px]" style={{ color: "#86efac" }}>
                Detectado: {autoDetected}
              </span>
            )}
          </label>

          {/* IMAP */}
          <fieldset
            className="rounded-lg p-3 space-y-3"
            style={{ border: "1px solid var(--border)", backgroundColor: "rgba(0,0,0,0.2)" }}
          >
            <legend
              className="px-2 text-xs uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              IMAP (recepção)
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <label className="block text-xs space-y-1 md:col-span-6">
                <span style={{ color: "var(--text-secondary)" }}>Servidor</span>
                <input
                  value={draft.imapHost}
                  onChange={(e) => update({ imapHost: e.target.value })}
                  placeholder="imap.empresa.com"
                  className="w-full rounded px-2 py-1.5 text-sm font-mono"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <label className="block text-xs space-y-1 md:col-span-3">
                <span style={{ color: "var(--text-secondary)" }}>Porta</span>
                <input
                  type="number"
                  value={draft.imapPort}
                  onChange={(e) => update({ imapPort: Number(e.target.value) || 0 })}
                  className="w-full rounded px-2 py-1.5 text-sm font-mono"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-xs md:col-span-3 mt-5">
                <input
                  type="checkbox"
                  checked={draft.imapTls}
                  onChange={(e) => update({ imapTls: e.target.checked })}
                />
                <span style={{ color: "var(--text-secondary)" }}>TLS/SSL</span>
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <label className="block text-xs space-y-1">
                <span style={{ color: "var(--text-secondary)" }}>Usuário</span>
                <input
                  value={draft.imapUser}
                  onChange={(e) => update({ imapUser: e.target.value })}
                  placeholder="geralmente o e-mail completo"
                  className="w-full rounded px-2 py-1.5 text-sm font-mono"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <label className="block text-xs space-y-1">
                <span style={{ color: "var(--text-secondary)" }}>
                  Senha {editing && "(deixe em branco para manter)"}
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type={showImapPwd ? "text" : "password"}
                    value={draft.imapPassword}
                    onChange={(e) => update({ imapPassword: e.target.value })}
                    placeholder={editing ? "•••••" : "senha ou App Password"}
                    className="flex-1 rounded px-2 py-1.5 text-sm font-mono"
                    style={{
                      backgroundColor: "rgba(0,0,0,0.3)",
                      border: "1px solid var(--border)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowImapPwd((v) => !v)}
                    className="p-1.5 rounded"
                    style={{
                      color: "var(--text-muted)",
                      backgroundColor: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--border)",
                    }}
                    aria-label={showImapPwd ? "Esconder" : "Mostrar"}
                  >
                    {showImapPwd ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </label>
            </div>
          </fieldset>

          {/* SMTP */}
          <fieldset
            className="rounded-lg p-3 space-y-3"
            style={{ border: "1px solid var(--border)", backgroundColor: "rgba(0,0,0,0.2)" }}
          >
            <legend
              className="px-2 text-xs uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              SMTP (envio)
            </legend>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.smtpSameAsImap}
                onChange={(e) => update({ smtpSameAsImap: e.target.checked })}
              />
              <span style={{ color: "var(--text-secondary)" }}>
                Mesmo usuário/senha do IMAP
              </span>
            </label>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <label className="block text-xs space-y-1 md:col-span-6">
                <span style={{ color: "var(--text-secondary)" }}>Servidor</span>
                <input
                  value={draft.smtpHost}
                  onChange={(e) => update({ smtpHost: e.target.value })}
                  placeholder="smtp.empresa.com"
                  className="w-full rounded px-2 py-1.5 text-sm font-mono"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <label className="block text-xs space-y-1 md:col-span-3">
                <span style={{ color: "var(--text-secondary)" }}>Porta</span>
                <input
                  type="number"
                  value={draft.smtpPort}
                  onChange={(e) => update({ smtpPort: Number(e.target.value) || 0 })}
                  className="w-full rounded px-2 py-1.5 text-sm font-mono"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-xs md:col-span-3 mt-5">
                <input
                  type="checkbox"
                  checked={draft.smtpTls}
                  onChange={(e) => update({ smtpTls: e.target.checked })}
                />
                <span style={{ color: "var(--text-secondary)" }}>TLS/SSL</span>
              </label>
            </div>
            {!draft.smtpSameAsImap && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <label className="block text-xs space-y-1">
                  <span style={{ color: "var(--text-secondary)" }}>Usuário</span>
                  <input
                    value={draft.smtpUser}
                    onChange={(e) => update({ smtpUser: e.target.value })}
                    className="w-full rounded px-2 py-1.5 text-sm font-mono"
                    style={{
                      backgroundColor: "rgba(0,0,0,0.3)",
                      border: "1px solid var(--border)",
                      color: "var(--text-primary)",
                    }}
                  />
                </label>
                <label className="block text-xs space-y-1">
                  <span style={{ color: "var(--text-secondary)" }}>Senha</span>
                  <div className="flex items-center gap-1">
                    <input
                      type={showSmtpPwd ? "text" : "password"}
                      value={draft.smtpPassword}
                      onChange={(e) => update({ smtpPassword: e.target.value })}
                      className="flex-1 rounded px-2 py-1.5 text-sm font-mono"
                      style={{
                        backgroundColor: "rgba(0,0,0,0.3)",
                        border: "1px solid var(--border)",
                        color: "var(--text-primary)",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSmtpPwd((v) => !v)}
                      className="p-1.5 rounded"
                      style={{
                        color: "var(--text-muted)",
                        backgroundColor: "rgba(255,255,255,0.04)",
                        border: "1px solid var(--border)",
                      }}
                      aria-label={showSmtpPwd ? "Esconder" : "Mostrar"}
                    >
                      {showSmtpPwd ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </label>
              </div>
            )}
          </fieldset>

          {testResult && (
            <div
              className="rounded-lg p-3 text-xs space-y-1"
              style={{
                backgroundColor: "rgba(0,0,0,0.25)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="flex items-center gap-2">
                {testResult.imap?.ok ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                )}
                <span style={{ color: "var(--text-primary)" }}>
                  IMAP — {testResult.imap?.ok ? "ok" : testResult.imap?.error || "falhou"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {testResult.smtp?.ok ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                )}
                <span style={{ color: "var(--text-primary)" }}>
                  SMTP — {testResult.smtp?.ok ? "ok" : testResult.smtp?.error || "falhou"}
                </span>
              </div>
            </div>
          )}

          {err && (
            <div
              className="p-2 rounded text-xs flex items-start gap-2"
              style={{
                backgroundColor: "rgba(239,68,68,0.08)",
                color: "#fca5a5",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
            >
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between px-5 py-3 border-t gap-3"
          style={{ borderColor: "var(--border)" }}
        >
          <button
            onClick={onTest}
            disabled={testing || saving}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg disabled:opacity-50"
            style={{
              backgroundColor: "rgba(16,185,129,0.1)",
              color: "#6ee7b7",
              border: "1px solid rgba(16,185,129,0.3)",
            }}
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
            Testar conexão
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-lg"
              style={{
                backgroundColor: "rgba(255,255,255,0.04)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              Cancelar
            </button>
            <button
              onClick={onSave}
              disabled={saving || testing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg font-medium disabled:opacity-50"
              style={{
                backgroundColor: "rgba(139,92,246,0.2)",
                color: "#c4b5fd",
                border: "1px solid rgba(139,92,246,0.4)",
              }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? "Salvando…" : "Salvar conta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
