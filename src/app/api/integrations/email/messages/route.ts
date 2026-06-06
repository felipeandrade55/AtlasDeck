/**
 * Unified message list (envelopes only — no body).
 *
 * GET /api/integrations/email/messages?accounts=a,b&folder=INBOX&q=&unread=1&page=1&limit=50
 *
 * "accounts" param is comma-separated; envelopes are merged across accounts
 * and ordered by date desc. When omitted, every configured account is used.
 */
import { NextRequest, NextResponse } from "next/server";
import { listMessages } from "@/lib/email-imap";
import { listAccounts } from "@/lib/email-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const accountsParam = url.searchParams.get("accounts");
  const accountIds = accountsParam
    ? accountsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : listAccounts().map((a) => a.id);

  if (accountIds.length === 0) {
    return NextResponse.json({ messages: [], total: 0, page: 1, limit: 50 });
  }

  const folder = url.searchParams.get("folder") || "INBOX";
  const q = url.searchParams.get("q") || undefined;
  const unread = url.searchParams.get("unread") === "1" || url.searchParams.get("unread") === "true";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || "50")));

  try {
    const result = await listMessages({ accountIds, folder, q, unread, page, limit });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
