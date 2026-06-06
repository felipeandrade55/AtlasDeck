/**
 * Flag toggles for a single message.
 *
 * POST /api/integrations/email/messages/:account/:uid/flags
 * Body: { seen?: boolean, flagged?: boolean, folder?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { setFlags } from "@/lib/email-imap";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ account: string; uid: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { account, uid } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const folder = typeof obj.folder === "string" ? obj.folder : "INBOX";
  const flags: { seen?: boolean; flagged?: boolean } = {};
  if (typeof obj.seen === "boolean") flags.seen = obj.seen;
  if (typeof obj.flagged === "boolean") flags.flagged = obj.flagged;

  try {
    await setFlags(account, uid, folder, flags);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
