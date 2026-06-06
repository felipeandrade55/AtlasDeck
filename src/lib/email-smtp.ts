/**
 * SMTP helpers — compose / reply / forward via nodemailer.
 *
 * One transport per request (no pooling). For interactive UI volume this
 * is fine and keeps the codepath stateless.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { ImapFlow } from "imapflow";
import type { StoredAccount } from "./email-store";
import { getAccount } from "./email-store";

export interface SendInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; contentBase64: string; contentType?: string }>;
}

function buildTransport(account: StoredAccount): Transporter {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.tls && account.smtp.port === 465, // 465=implicit TLS, 587=STARTTLS
    auth: { user: account.smtp.user, pass: account.smtp.password },
    requireTLS: account.smtp.tls && account.smtp.port !== 465,
  });
}

export async function testSmtpConnection(account: StoredAccount): Promise<{ ok: boolean; error?: string }> {
  const transport = buildTransport(account);
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    transport.close();
  }
}

export async function sendMail(input: SendInput): Promise<{ ok: true; messageId?: string }> {
  const account = getAccount(input.accountId);
  if (!account) throw new Error(`Conta '${input.accountId}' não encontrada`);

  const transport = buildTransport(account);
  try {
    const fromHeader = account.name
      ? `${account.name} <${account.emailAddress}>`
      : account.emailAddress;

    const info = await transport.sendMail({
      from: fromHeader,
      to: input.to.join(", "),
      cc: input.cc?.length ? input.cc.join(", ") : undefined,
      bcc: input.bcc?.length ? input.bcc.join(", ") : undefined,
      subject: input.subject,
      text: input.body,
      html: input.bodyHtml,
      inReplyTo: input.inReplyTo,
      references: input.references?.length ? input.references.join(" ") : undefined,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
      })),
    });

    // Best-effort: append the sent message to the Sent folder via IMAP so
    // the user sees their own reply in the thread. Failure is non-fatal.
    try {
      await appendToSent(account, info.message as unknown as string | Buffer | undefined);
    } catch {
      // ignore — some providers (Gmail) auto-append already
    }

    return { ok: true, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

async function appendToSent(account: StoredAccount, raw: string | Buffer | undefined): Promise<void> {
  if (!raw) return;
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    auth: { user: account.imap.user, pass: account.imap.password },
    logger: false,
    socketTimeout: 15_000,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find(
      (b) =>
        b.specialUse === "\\Sent" ||
        /sent|enviado/i.test(b.path) ||
        /sent|enviado/i.test(b.name || ""),
    );
    if (!sent) return;
    await client.append(sent.path, raw, ["\\Seen"]);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}
