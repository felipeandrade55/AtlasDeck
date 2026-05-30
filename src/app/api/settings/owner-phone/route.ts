/**
 * GET/PUT for the owner's WhatsApp number (used by Assessor mode to
 * validate "command came from Felipe himself").
 *
 *   GET → { ownerPhone: "5564992224800" | null, normalized: "+5564992224800" | null }
 *   PUT body { ownerPhone: string|null } → persists. Empty/null clears it.
 *
 * Number is stored as E.164 digits-only (no +, no formatting). The MCP
 * tool `get_owner_phone` returns BOTH the digits-only form AND the JID
 * shape (5564992224800@s.whatsapp.net) so the agent can match against
 * Baileys' remoteJid without any string-munging on its side.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings } from "@/lib/memory-db";

export const dynamic = "force-dynamic";

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export async function GET() {
  try {
    const s = getSettings();
    const phone = normalizePhone(s.owner_whatsapp_number);
    return NextResponse.json({
      ownerPhone: phone,
      normalized: phone ? `+${phone}` : null,
      jid: phone ? `${phone}@s.whatsapp.net` : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  let body: { ownerPhone?: string | null } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }
  try {
    const phone = normalizePhone(body.ownerPhone ?? null);
    setSettings({ owner_whatsapp_number: phone });
    return NextResponse.json({
      ok: true,
      ownerPhone: phone,
      normalized: phone ? `+${phone}` : null,
      jid: phone ? `${phone}@s.whatsapp.net` : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
