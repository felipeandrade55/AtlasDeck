/**
 * POST /api/integrations/whatsapp/cleanup-old-rotations
 *
 * Manual trigger for "Limpar rotações antigas agora". Wraps
 * `cleanupOldWhatsappRotations()` so the modal can free disk space
 * without SSH and without waiting for the next watchdog tick.
 *
 * Body (all optional):
 *   { agentId?: string, olderThanDays?: number, dryRun?: boolean }
 *
 * Defaults `olderThanDays` to the saved config (cleanupDays). When the
 * saved value is 0 (cleanup disabled), defaults to 7 — the manual
 * button should always do *something*, even if auto-cleanup is off.
 *
 * dryRun=true returns the plan (which files would be deleted, total
 * MB) without touching disk — used by the UI to preview before commit.
 */
import { NextRequest, NextResponse } from "next/server";
import { cleanupOldWhatsappRotations } from "@/lib/whatsapp-session-rotator";
import {
  getWhatsappRotationConfig,
  markWhatsappCleanup,
} from "@/lib/whatsapp-rotation-config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { agentId?: string; olderThanDays?: number; dryRun?: boolean } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    // Empty body is fine.
  }

  const cfg = getWhatsappRotationConfig();
  // Falls back to the saved cleanupDays, then to 7 if the user has
  // explicitly disabled cleanup (cleanupDays=0) but still wants the
  // manual button to do something useful.
  const olderThanDays =
    typeof body.olderThanDays === "number" && body.olderThanDays >= 1
      ? body.olderThanDays
      : cfg.cleanupDays >= 1
        ? cfg.cleanupDays
        : 7;

  const result = await cleanupOldWhatsappRotations({
    agentId: body.agentId,
    olderThanDays,
    dryRun: body.dryRun === true,
    triggeredBy: "manual",
  });

  // Update last-cleanup stats only on real runs (not dryRun) and only
  // when something was actually deleted, so a "nothing to clean" click
  // doesn't reset the timer.
  if (!result.dryRun && result.deleted.length > 0) {
    markWhatsappCleanup(result.deleted.length, result.totalBytesFreed);
  }

  return NextResponse.json({
    ...result,
    olderThanDays,
  });
}
