/**
 * POST /api/integrations/whatsapp/qr-login
 *
 * Triggers WhatsApp Web QR pairing via the gateway's /tools/invoke
 * `whatsapp_login` (action=start). The tool returns the QR as a PNG data
 * URL, which the UI then renders as an <img> — no TTY/spawn needed.
 *
 * Returns 412 with a clear hint when the gateway refuses (deny list not
 * patched yet) so the UI can prompt the user to click "Reparar config".
 */
import { NextRequest, NextResponse } from "next/server";
import {
  whatsappLoginStart,
  whatsappLoginWait,
} from "@/lib/openclaw-tool-invoke";
import { sweepOpenClawConfig } from "@/lib/openclaw-config-sweep";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { accountId?: string; action?: "start" | "wait"; currentQrDataUrl?: string; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  const accountId = (body.accountId || "main").trim();
  const action = body.action === "wait" ? "wait" : "start";

  try {
    // Always make sure gateway.tools.allow includes whatsapp_login. The
    // sweep is cheap and idempotent — if config is already correct it's a
    // no-op. Running before invoke covers the case where the user pulled
    // this version and clicked Parear before the boot sweep had a chance
    // to run.
    sweepOpenClawConfig();

    const r =
      action === "wait"
        ? await whatsappLoginWait({
            accountId,
            currentQrDataUrl: body.currentQrDataUrl,
            timeoutMs: 30_000,
          })
        : await whatsappLoginStart({
            accountId,
            force: body.force,
            timeoutMs: 45_000,
          });

    if (!r.ok) {
      const denyHint =
        r.httpStatus === 404
          ? "Gateway negou o tool whatsapp_login. Clique em 'Reparar config' (libera o tool no gateway.tools.allow) e reinicie o gateway."
          : undefined;

      return NextResponse.json(
        {
          ok: false,
          error: r.error.message,
          errorType: r.error.type,
          httpStatus: r.httpStatus,
          hint: denyHint,
        },
        { status: r.httpStatus === 404 ? 412 : r.httpStatus || 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      qrDataUrl: r.result.qrDataUrl ?? null,
      message: r.result.message ?? null,
      connected: r.result.connected === true,
      hasQr: r.result.qr === true,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
