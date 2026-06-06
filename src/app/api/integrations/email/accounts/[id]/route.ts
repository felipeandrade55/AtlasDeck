/**
 * Single account ops.
 *
 * DELETE /api/integrations/email/accounts/:id
 * POST   /api/integrations/email/accounts/:id?action=test → re-test IMAP+SMTP
 * PATCH  /api/integrations/email/accounts/:id              → edit fields
 */
import { NextRequest, NextResponse } from "next/server";
import {
  deleteAccount,
  getAccount,
  patchAccount,
  markAccountStatus,
  type AccountUpsertInput,
} from "@/lib/email-store";
import { testImapConnection } from "@/lib/email-imap";
import { testSmtpConnection } from "@/lib/email-smtp";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const ok = deleteAccount(id);
  if (!ok) {
    return NextResponse.json({ error: `Conta '${id}' não encontrada` }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action") || "test";

  if (action !== "test") {
    return NextResponse.json(
      { error: `Ação desconhecida: "${action}". Use ?action=test` },
      { status: 400 },
    );
  }

  const account = getAccount(id);
  if (!account) {
    return NextResponse.json({ error: `Conta '${id}' não encontrada` }, { status: 404 });
  }

  const [imapResult, smtpResult] = await Promise.all([
    testImapConnection(account),
    testSmtpConnection(account),
  ]);

  const issues: string[] = [];
  if (!imapResult.ok) issues.push(`IMAP: ${imapResult.error}`);
  if (!smtpResult.ok) issues.push(`SMTP: ${smtpResult.error}`);
  markAccountStatus(id, issues.length === 0 ? "configured" : "error", issues.join(" | ") || null);

  return NextResponse.json({
    ok: imapResult.ok && smtpResult.ok,
    imap: imapResult,
    smtp: smtpResult,
  });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: Partial<AccountUpsertInput> = {};
  if (typeof obj.name === "string") patch.name = obj.name.trim();
  if (typeof obj.emailAddress === "string") patch.emailAddress = obj.emailAddress.trim();
  if (obj.imap && typeof obj.imap === "object") {
    const i = obj.imap as Record<string, unknown>;
    patch.imap = {
      host: String(i.host ?? ""),
      port: Number(i.port ?? 993),
      tls: i.tls !== false,
      user: String(i.user ?? ""),
      password: String(i.password ?? ""),
    };
  }
  if (obj.smtp && typeof obj.smtp === "object") {
    const s = obj.smtp as Record<string, unknown>;
    patch.smtp = {
      host: String(s.host ?? ""),
      port: Number(s.port ?? 587),
      tls: s.tls !== false,
      user: String(s.user ?? ""),
      password: String(s.password ?? ""),
    };
  }

  const updated = patchAccount(id, patch);
  if (!updated) {
    return NextResponse.json({ error: `Conta '${id}' não encontrada` }, { status: 404 });
  }
  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    emailAddress: updated.emailAddress,
    status: updated.status,
    imap: { host: updated.imap.host, port: updated.imap.port, tls: updated.imap.tls, user: updated.imap.user },
    smtp: { host: updated.smtp.host, port: updated.smtp.port, tls: updated.smtp.tls, user: updated.smtp.user },
  });
}
