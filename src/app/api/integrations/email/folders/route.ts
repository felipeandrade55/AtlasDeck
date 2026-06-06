/**
 * Folder listing per account.
 *
 * GET /api/integrations/email/folders?account=ID  → list of folders/mailboxes
 */
import { NextRequest, NextResponse } from "next/server";
import { listFolders } from "@/lib/email-imap";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const account = new URL(req.url).searchParams.get("account") || "";
  if (!account) {
    return NextResponse.json({ error: "Parâmetro 'account' obrigatório" }, { status: 400 });
  }
  try {
    const folders = await listFolders(account);
    return NextResponse.json(folders);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
