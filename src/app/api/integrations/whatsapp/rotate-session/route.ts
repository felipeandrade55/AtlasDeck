/**
 * POST /api/integrations/whatsapp/rotate-session
 *
 * Manual trigger for "Resetar memória da conversa do WhatsApp agora".
 * Wraps `rotateActiveWhatsappSession()` so the modal can fire a
 * rotation without exec-ing arbitrary shell commands.
 *
 * Body (all optional):
 *   { agentId?: string, dryRun?: boolean }
 *
 * Returns the RotateWhatsappResult so the UI can show which files were
 * rotated and how many bytes were freed.
 */
import { NextRequest, NextResponse } from "next/server";
import { rotateActiveWhatsappSession } from "@/lib/whatsapp-session-rotator";
import { markWhatsappRotated } from "@/lib/whatsapp-rotation-config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { agentId?: string; dryRun?: boolean } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    // Empty body is fine — defaults rotate the main agent's whatsapp.
  }

  const result = await rotateActiveWhatsappSession({
    agentId: body.agentId,
    dryRun: body.dryRun,
    triggeredBy: "manual",
  });

  // Update the watchdog's lastRotatedAt even on manual triggers so the
  // schedule doesn't fire again immediately after the user just did it.
  if (result.rotated) markWhatsappRotated();

  return NextResponse.json(result, {
    status: result.rotated || body.dryRun ? 200 : 409,
  });
}
