/**
 * Full message body for a single envelope.
 *
 * GET /api/integrations/email/messages/:account/:uid → body + headers + attachments metadata
 */
import { NextRequest, NextResponse } from "next/server";
import { getMessage } from "@/lib/email-imap";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ account: string; uid: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { account, uid } = await ctx.params;
  const folder = new URL(req.url).searchParams.get("folder") || "INBOX";
  try {
    const message = await getMessage(account, uid, folder);
    return NextResponse.json(message);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /não encontrada/i.test(message) ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
