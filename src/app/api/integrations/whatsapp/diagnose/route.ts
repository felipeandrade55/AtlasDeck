/**
 * GET  /api/integrations/whatsapp/diagnose
 * POST /api/integrations/whatsapp/diagnose
 *
 * Thin HTTP wrapper around lib/whatsapp-diagnostic.
 */
import { NextRequest, NextResponse } from "next/server";
import { runDiagnose } from "@/lib/whatsapp-diagnostic";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sendTest = url.searchParams.get("test") === "1";
  const testAccountId = url.searchParams.get("accountId") || undefined;
  try {
    const r = await runDiagnose({ sendTest, testAccountId });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { sendTest?: boolean; testMessage?: string; accountId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  try {
    const r = await runDiagnose({
      sendTest: body.sendTest !== false,
      testMessage: body.testMessage,
      testAccountId: body.accountId,
    });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
