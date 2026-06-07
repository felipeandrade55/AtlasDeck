/**
 * POST /api/telegram/rotate-session
 *
 * Manual entry point for "Resetar conversa do Telegram agora". Wraps
 * `rotateActiveTelegramSession()` so the diagnose card can trigger a
 * rotation without exec-ing arbitrary commands. The same primitive that
 * the auto-watchdog uses, but with `triggeredBy: "manual"` so the
 * activity log can tell them apart.
 *
 * Body (all optional):
 *   { agentId?: string, chatId?: string|number, dryRun?: boolean }
 *
 * Returns the RotateSessionResult shape so the UI can show the file
 * that was rotated and the new name.
 */
import { NextRequest, NextResponse } from "next/server";
import { rotateActiveTelegramSession } from "@/lib/telegram-session-rotator";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { agentId?: string; chatId?: string | number; dryRun?: boolean } = {};
  try {
    if (request.headers.get("content-length") !== "0") {
      body = await request.json();
    }
  } catch {
    // Empty body is fine — defaults rotate the main agent's active session.
  }

  const result = await rotateActiveTelegramSession({
    agentId: body.agentId,
    chatId: body.chatId,
    dryRun: body.dryRun,
    triggeredBy: "manual",
  });

  logActivity(
    'command',
    body.dryRun ? 'Rotação de sessão Telegram simulada' : 'Rotação de sessão Telegram executada',
    result.rotated || body.dryRun ? 'success' : 'error',
    { metadata: { agentId: body.agentId, chatId: body.chatId, rotated: result.rotated, filePath: result.filePath, rotatedTo: result.rotatedTo } }
  );

  return NextResponse.json(result, {
    status: result.rotated || body.dryRun ? 200 : 409,
  });
}
