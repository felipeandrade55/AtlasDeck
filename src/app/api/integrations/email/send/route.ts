/**
 * Compose / reply / forward — SMTP send.
 *
 * POST /api/integrations/email/send
 */
import { NextRequest, NextResponse } from "next/server";
import { sendMail, type SendInput } from "@/lib/email-smtp";

export const dynamic = "force-dynamic";

function parseAttachments(input: unknown): SendInput["attachments"] {
  if (!Array.isArray(input)) return undefined;
  const out: { filename: string; contentBase64: string; contentType?: string }[] = [];
  for (const a of input) {
    if (!a || typeof a !== "object") continue;
    const ao = a as Record<string, unknown>;
    const filename = typeof ao.filename === "string" ? ao.filename : "";
    const contentBase64 = typeof ao.contentBase64 === "string" ? ao.contentBase64 : "";
    if (!filename || !contentBase64) continue;
    out.push({
      filename,
      contentBase64,
      contentType: typeof ao.contentType === "string" ? ao.contentType : undefined,
    });
  }
  return out.length ? out : undefined;
}

function validate(input: unknown): SendInput | { error: string } {
  if (!input || typeof input !== "object") return { error: "Body inválido" };
  const obj = input as Record<string, unknown>;
  const accountId = typeof obj.accountId === "string" ? obj.accountId.trim() : "";
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const body = typeof obj.body === "string" ? obj.body : "";
  const to = Array.isArray(obj.to)
    ? obj.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (!accountId) return { error: "Campo 'accountId' obrigatório" };
  if (to.length === 0) return { error: "Campo 'to' precisa ter ao menos um destinatário" };

  return {
    accountId,
    to,
    cc: Array.isArray(obj.cc) ? obj.cc.filter((x): x is string => typeof x === "string") : undefined,
    bcc: Array.isArray(obj.bcc) ? obj.bcc.filter((x): x is string => typeof x === "string") : undefined,
    subject,
    body,
    bodyHtml: typeof obj.bodyHtml === "string" ? obj.bodyHtml : undefined,
    inReplyTo: typeof obj.inReplyTo === "string" ? obj.inReplyTo : undefined,
    references: Array.isArray(obj.references)
      ? obj.references.filter((x): x is string => typeof x === "string")
      : undefined,
    attachments: parseAttachments(obj.attachments),
  };
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

  try {
    const result = await sendMail(parsed);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
