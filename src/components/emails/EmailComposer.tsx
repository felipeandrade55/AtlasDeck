"use client";

/**
 * Compose / reply / forward email.
 *
 * Always uses the same modal — the parent passes `mode` and (for reply/forward)
 * a `replyTo` envelope so we can pre-fill subject, recipients and threading
 * headers. SMTP send goes through /api/integrations/email/send.
 */
import { useEffect, useMemo, useState } from "react";
import { X, Send, Loader2, AlertTriangle } from "lucide-react";
import {
  emailsClient,
  formatAddress,
  type EmailAccount,
  type EmailMessage,
  type SendInput,
} from "@/lib/emails-client";

type ComposeMode = "new" | "reply" | "reply-all" | "forward";

interface Props {
  open: boolean;
  onClose: () => void;
  accounts: EmailAccount[];
  defaultAccountId?: string;
  mode?: ComposeMode;
  replyTo?: EmailMessage | null;
  onSent?: () => void;
}

function parseAddressList(input: string): string[] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildReplyDefaults(
  source: EmailMessage,
  mode: ComposeMode,
): { to: string; cc: string; subject: string; body: string } {
  const fromAddr = source.from[0]?.address ?? "";
  const reSubject = (s: string) =>
    /^re:\s/i.test(s) ? s : `Re: ${s}`;
  const fwSubject = (s: string) =>
    /^fwd?:\s/i.test(s) ? s : `Fwd: ${s}`;
  const quoted = (() => {
    const text = source.bodyText ?? "";
    const header = `\n\n--- Em ${new Date(source.date).toLocaleString("pt-BR")}, ${
      source.from.map(formatAddress).join(", ")
    } escreveu: ---\n`;
    return header + text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  })();

  switch (mode) {
    case "reply":
      return {
        to: fromAddr,
        cc: "",
        subject: reSubject(source.subject),
        body: quoted,
      };
    case "reply-all": {
      const cc = [...(source.to ?? []), ...(source.cc ?? [])]
        .map((a) => a.address)
        .filter((addr) => addr && addr !== fromAddr)
        .join(", ");
      return { to: fromAddr, cc, subject: reSubject(source.subject), body: quoted };
    }
    case "forward":
      return {
        to: "",
        cc: "",
        subject: fwSubject(source.subject),
        body:
          `\n\n--- Mensagem encaminhada ---\n` +
          `De: ${source.from.map(formatAddress).join(", ")}\n` +
          `Data: ${new Date(source.date).toLocaleString("pt-BR")}\n` +
          `Assunto: ${source.subject}\n` +
          `Para: ${(source.to ?? []).map(formatAddress).join(", ")}\n\n` +
          (source.bodyText ?? ""),
      };
    default:
      return { to: "", cc: "", subject: "", body: "" };
  }
}

export function EmailComposer({
  open,
  onClose,
  accounts,
  defaultAccountId,
  mode = "new",
  replyTo = null,
  onSent,
}: Props) {
  const initial = useMemo(() => {
    if (replyTo && mode !== "new") return buildReplyDefaults(replyTo, mode);
    return { to: "", cc: "", subject: "", body: "" };
  }, [replyTo, mode]);

  const [accountId, setAccountId] = useState<string>("");
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setTo(initial.to);
    setCc(initial.cc);
    setBcc("");
    setSubject(initial.subject);
    setBody(initial.body);
    // pick the account: replyTo's owning account, then defaultAccountId, then first
    const pick =
      (replyTo && accounts.find((a) => a.id === replyTo.accountId)?.id) ||
      defaultAccountId ||
      accounts[0]?.id ||
      "";
    setAccountId(pick);
  }, [open, initial, replyTo, defaultAccountId, accounts]);

  const onSend = async () => {
    if (!accountId) {
      setErr("Selecione a conta de envio.");
      return;
    }
    const toList = parseAddressList(to);
    if (toList.length === 0) {
      setErr("Adicione ao menos um destinatário.");
      return;
    }
    if (!subject.trim() && !confirm("Enviar sem assunto?")) return;

    setSending(true);
    setErr(null);
    try {
      const payload: SendInput = {
        accountId,
        to: toList,
        cc: parseAddressList(cc),
        bcc: parseAddressList(bcc),
        subject,
        body,
        inReplyTo: replyTo?.messageId,
        references: replyTo?.references,
      };
      await emailsClient.send(payload);
      onSent?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  const title =
    mode === "reply" || mode === "reply-all"
      ? "Responder"
      : mode === "forward"
        ? "Encaminhar"
        : "Nova mensagem";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.65)" }}
      onClick={onClose}
    >
      <div
        className="rounded-xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg"
            style={{ color: "var(--text-secondary)" }}
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="block text-xs space-y-1">
              <span style={{ color: "var(--text-secondary)" }}>De</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full rounded px-2 py-1.5 text-sm"
                style={{
                  backgroundColor: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="" disabled>
                  Selecione a conta
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name ? `${a.name} — ` : ""}
                    {a.emailAddress}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <Field label="Para" value={to} onChange={setTo} placeholder="dest1@exemplo.com, dest2@exemplo.com" />
          <Field label="Cc" value={cc} onChange={setCc} placeholder="opcional" />
          <Field label="Bcc" value={bcc} onChange={setBcc} placeholder="opcional" />
          <Field label="Assunto" value={subject} onChange={setSubject} placeholder="" />

          <label className="block text-xs space-y-1">
            <span style={{ color: "var(--text-secondary)" }}>Mensagem</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="w-full rounded px-2 py-1.5 text-sm font-mono"
              style={{
                backgroundColor: "rgba(0,0,0,0.3)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                resize: "vertical",
              }}
            />
          </label>

          {err && (
            <div
              className="p-2 rounded text-xs flex items-start gap-2"
              style={{
                backgroundColor: "rgba(239,68,68,0.08)",
                color: "#fca5a5",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end px-5 py-3 border-t gap-2"
          style={{ borderColor: "var(--border)" }}
        >
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
            onClick={onSend}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg font-medium disabled:opacity-50"
            style={{
              backgroundColor: "rgba(139,92,246,0.2)",
              color: "#c4b5fd",
              border: "1px solid rgba(139,92,246,0.4)",
            }}
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block text-xs space-y-1">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded px-2 py-1.5 text-sm"
        style={{
          backgroundColor: "rgba(0,0,0,0.3)",
          border: "1px solid var(--border)",
          color: "var(--text-primary)",
        }}
      />
    </label>
  );
}
