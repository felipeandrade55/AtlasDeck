/**
 * GET/PUT /api/integrations/whatsapp/rotation-config
 *
 * Read or update the WhatsApp auto-rotation schedule the watchdog
 * (`whatsapp-rotation-watchdog`) reads on every tick.
 *
 * GET response:
 *   { enabled: boolean, intervalHours: number, lastRotatedAt: number,
 *     watchdog: { started: boolean, lastTickAt: number,
 *                 rotationsCount: number, lastError: string | null } }
 *
 * PUT body:
 *   { enabled?: boolean, intervalHours?: number }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getWhatsappRotationConfig,
  setWhatsappRotationConfig,
} from "@/lib/whatsapp-rotation-config";
import {
  getWhatsappRotationWatchdogState,
  startWhatsappRotationWatchdog,
} from "@/lib/whatsapp-rotation-watchdog";

export const dynamic = "force-dynamic";

function snapshot() {
  const cfg = getWhatsappRotationConfig();
  const wd = getWhatsappRotationWatchdogState();
  return {
    enabled: cfg.enabled,
    intervalHours: cfg.intervalHours,
    lastRotatedAt: cfg.lastRotatedAt,
    cleanupDays: cfg.cleanupDays,
    lastCleanupAt: cfg.lastCleanupAt,
    lastCleanupFilesDeleted: cfg.lastCleanupFilesDeleted,
    lastCleanupBytesFreed: cfg.lastCleanupBytesFreed,
    watchdog: {
      started: wd.started,
      lastTickAt: wd.lastTickAt,
      rotationsCount: wd.rotationsCount,
      cleanupsCount: wd.cleanupsCount,
      lastError: wd.lastError,
    },
  };
}

export async function GET() {
  // Lazy-start so the watchdog kicks in the first time the modal is
  // opened, even if instrumentation didn't (e.g. dev hot-reload).
  startWhatsappRotationWatchdog();
  return NextResponse.json(snapshot());
}

export async function PUT(req: NextRequest) {
  let body: { enabled?: boolean; intervalHours?: number; cleanupDays?: number } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body JSON inválido — espera { enabled?: boolean, intervalHours?: number, cleanupDays?: number }" },
      { status: 400 },
    );
  }

  setWhatsappRotationConfig({
    enabled: body.enabled,
    intervalHours: body.intervalHours,
    cleanupDays: body.cleanupDays,
  });
  // Make sure the watchdog is up so the new config takes effect on
  // the next tick (within 60s) without needing a process restart.
  startWhatsappRotationWatchdog();
  return NextResponse.json(snapshot());
}
