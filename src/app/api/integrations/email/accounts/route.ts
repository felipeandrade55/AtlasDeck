/**
 * Email accounts — list + create.
 *
 * GET  /api/integrations/email/accounts  → array of configured accounts (no secrets)
 * POST /api/integrations/email/accounts  → add a new account (validates IMAP+SMTP)
 *
 * AtlasDeck owns IMAP/SMTP directly — credentials live in
 * `data/email-accounts.json` (chmod 600). The OpenClaw daemon is not involved.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  listAccounts,
  upsertAccount,
  markAccountStatus,
  type AccountUpsertInput,
} from "@/lib/email-store";
import { testImapConnection } from "@/lib/email-imap";
import { testSmtpConnection } from "@/lib/email-smtp";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listAccounts());
}

function validate(input: unknown): AccountUpsertInput | { error: string } {
  if (!input || typeof input !== "object") return { error: "Body inválido" };
  const obj = input as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const emailAddress = typeof obj.emailAddress === "string" ? obj.emailAddress.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : undefined;
  const imapRaw = obj.imap as Record<string, unknown> | undefined;
  const smtpRaw = obj.smtp as Record<string, unknown> | undefined;
  if (!id) return { error: "Campo 'id' obrigatório" };
  if (!emailAddress) return { error: "Campo 'emailAddress' obrigatório" };
  if (!imapRaw || !smtpRaw) return { error: "Configuração IMAP e SMTP obrigatórias" };

  const imap = {
    host: String(imapRaw.host ?? "").trim(),
    port: Number(imapRaw.port ?? 993),
    tls: imapRaw.tls !== false,
    user: String(imapRaw.user ?? "").trim(),
    password: String(imapRaw.password ?? ""),
  };
  const smtp = {
    host: String(smtpRaw.host ?? "").trim(),
    port: Number(smtpRaw.port ?? 587),
    tls: smtpRaw.tls !== false,
    user: String(smtpRaw.user ?? "").trim(),
    password: String(smtpRaw.password ?? ""),
  };

  if (!imap.host || !imap.user || !imap.password) {
    return { error: "Host, usuário e senha do IMAP são obrigatórios" };
  }
  if (!smtp.host || !smtp.user || !smtp.password) {
    return { error: "Host, usuário e senha do SMTP são obrigatórios" };
  }

  return { id, name, emailAddress, imap, smtp };
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }
  const parsed = validate(raw);
  if ("error" in parsed) {
    return NextResponse.json(parsed, { status: 400 });
  }

  // Save first so the test functions can fetch from the store, then
  // run live IMAP+SMTP probes. If both fail, we mark the account as errored
  // but still keep it (the user can fix and retest).
  const saved = upsertAccount(parsed);
  const [imapResult, smtpResult] = await Promise.all([
    testImapConnection(saved),
    testSmtpConnection(saved),
  ]);

  const issues: string[] = [];
  if (!imapResult.ok) issues.push(`IMAP: ${imapResult.error}`);
  if (!smtpResult.ok) issues.push(`SMTP: ${smtpResult.error}`);
  markAccountStatus(saved.id, issues.length === 0 ? "configured" : "error", issues.join(" | ") || null);

  return NextResponse.json({
    id: saved.id,
    name: saved.name,
    emailAddress: saved.emailAddress,
    status: issues.length === 0 ? "configured" : "error",
    issues: issues.length ? issues : undefined,
    imap: { host: saved.imap.host, port: saved.imap.port, tls: saved.imap.tls, user: saved.imap.user },
    smtp: { host: saved.smtp.host, port: saved.smtp.port, tls: saved.smtp.tls, user: saved.smtp.user },
  });
}
