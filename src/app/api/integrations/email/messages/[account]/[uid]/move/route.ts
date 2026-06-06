/**
 * Move a message to another folder.
 *
 * POST /api/integrations/email/messages/:account/:uid/move
 * Body: { folder: string, sourceFolder?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { moveMessage } from "@/lib/email-imap";

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
  const folder = typeof obj.folder === "string" ? obj.folder.trim() : "";
  const sourceFolder = typeof obj.sourceFolder === "string" ? obj.sourceFolder.trim() : "INBOX";
  if (!folder) {
    return NextResponse.json({ error: "Campo 'folder' obrigatório" }, { status: 400 });
  }

  try {
    await moveMessage(account, uid, sourceFolder, folder);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
