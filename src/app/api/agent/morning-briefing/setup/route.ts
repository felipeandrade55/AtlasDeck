/**
 * Install/uninstall/status for the morning briefing.
 *
 * The actual schedule is owned by the in-process calendar-scheduler (which
 * checks `morning_briefing_enabled` every minute and fires at 07:00 in the
 * user's timezone). This endpoint just toggles the flag and starts the
 * scheduler the first time it's enabled.
 *
 * GET    — returns whether the briefing is enabled
 * POST   — enables it (idempotent)
 * DELETE — disables it
 */
import { NextResponse } from "next/server";
import { getSettings, setSettings } from "@/lib/memory-db";
import { startCalendarScheduler, isCalendarSchedulerStarted } from "@/lib/calendar-scheduler";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCHEDULE = "0 7 * * *";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({
    installed: !!settings.morning_briefing_enabled,
    available: true,
    schedule: SCHEDULE,
    timezone: settings.home_timezone || "America/Sao_Paulo",
    scheduler_running: isCalendarSchedulerStarted(),
  });
}

export async function POST() {
  setSettings({ morning_briefing_enabled: true });
  startCalendarScheduler();
  logActivity('config', 'Briefing matinal ativado', 'success', { metadata: { schedule: SCHEDULE } });
  return NextResponse.json({ installed: true, schedule: SCHEDULE });
}

export async function DELETE() {
  setSettings({ morning_briefing_enabled: false });
  logActivity('config', 'Briefing matinal desativado', 'success');
  return NextResponse.json({ removed: true });
}
