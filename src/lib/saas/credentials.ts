/**
 * Deliver a client's access credentials by email (the owner's choice).
 * Runs on the control plane after the client's app is healthy. Uses the
 * owner's configured SMTP account (data/email-accounts.json) via sendMail.
 */
import { sendMail } from "@/lib/email-smtp";
import { listAccountsWithSecrets } from "@/lib/email-store";
import { getClient, updateClient, type SaasClient } from "./saas-clients-db";

function pickSmtpAccountId(): string | null {
  const accounts = listAccountsWithSecrets();
  const configured = accounts.find((a) => a.status === "configured") ?? accounts[0];
  return configured?.id ?? null;
}

function buildBody(client: SaasClient): { subject: string; text: string; html: string } {
  const url = client.fqdn ? `https://${client.fqdn}` : "(em provisionamento)";
  const subject = `Seu AtlasDeck está pronto, ${client.name}!`;
  const text = [
    `Olá, ${client.name}!`,
    ``,
    `Seu AtlasDeck foi provisionado e já está no ar. Acesse:`,
    ``,
    `  Endereço: ${url}`,
    `  Usuário:  admin`,
    `  Senha:    ${client.admin_password ?? "(indisponível)"}`,
    ``,
    `No primeiro acesso, um assistente guiado ajuda a configurar seu agente`,
    `(modelo de IA, personalidade e Telegram). Guarde esta senha em local seguro.`,
    ``,
    `Qualquer dúvida, é só responder este email.`,
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;line-height:1.6">
      <p>Olá, <strong>${client.name}</strong>!</p>
      <p>Seu AtlasDeck foi provisionado e já está no ar.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Endereço</td><td><a href="${url}">${url}</a></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Usuário</td><td><code>admin</code></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Senha</td><td><code>${client.admin_password ?? "(indisponível)"}</code></td></tr>
      </table>
      <p>No primeiro acesso, um assistente guiado ajuda a configurar seu agente (modelo de IA, personalidade e Telegram). Guarde esta senha em local seguro.</p>
      <p style="color:#666">Qualquer dúvida, é só responder este email.</p>
    </div>`;
  return { subject, text, html };
}

export interface DeliverResult {
  ok: boolean;
  channel: "email";
  error?: string;
}

/** Send the welcome email with credentials and record the delivery. */
export async function deliverCredentials(slug: string): Promise<DeliverResult> {
  const client = getClient(slug);
  if (!client) return { ok: false, channel: "email", error: `Cliente '${slug}' não existe.` };
  if (!client.contact_email) {
    return { ok: false, channel: "email", error: "Cliente sem email de contato." };
  }
  const accountId = pickSmtpAccountId();
  if (!accountId) {
    return {
      ok: false,
      channel: "email",
      error: "Nenhuma conta SMTP configurada (Configurações → Email).",
    };
  }
  try {
    const { subject, text, html } = buildBody(client);
    await sendMail({ accountId, to: [client.contact_email], subject, body: text, bodyHtml: html });
    updateClient(slug, {
      credentials_delivered_at: new Date().toISOString(),
      delivery_channel: "email",
    });
    return { ok: true, channel: "email" };
  } catch (err) {
    return { ok: false, channel: "email", error: err instanceof Error ? err.message : String(err) };
  }
}
