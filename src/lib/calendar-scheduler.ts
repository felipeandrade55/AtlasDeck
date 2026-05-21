/**
 * In-process scheduler for calendar background jobs.
 *
 * Why: OpenClaw cron doesn't shell-exec (every tick spawns an agent turn), so
 * using it for HTTP-ping crons (reminders/dispatch, bookings/scan-pending,
 * morning briefing) would burn LLM tokens on every minute. This scheduler
 * fires the endpoints in-process via localhost fetch — free, deterministic,
 * survives PM2 restart with no external dependency.
 *
 * Lazy-started from /api/notifications (same pattern as update-scheduler).
 */

import { getServiceToken } from "./openclaw-auth";
import { getSettings } from "./memory-db";

let started = false;

const REMINDER_INTERVAL_MS = 60_000;
const BOOKINGS_NUDGE_INTERVAL_MS = 30 * 60_000;
const BRIEFING_CHECK_INTERVAL_MS = 60_000;
const BRIEFING_HOUR = 7;

let lastBriefingFireDate: string | null = null;

function baseUrl(): string {
  if (process.env.ATLASDECK_INTERNAL_BASE_URL) return process.env.ATLASDECK_INTERNAL_BASE_URL;
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function tickReminders() {
  try {
    const res = await fetch(`${baseUrl()}/api/calendar/reminders/dispatch`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) console.warn(`[calendar-scheduler] reminders ${res.status}`);
  } catch (err) {
    console.warn("[calendar-scheduler] reminders failed:", err);
  }
}

async function tickBookingsNudge() {
  try {
    const res = await fetch(`${baseUrl()}/api/calendar/bookings/scan-pending`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) console.warn(`[calendar-scheduler] bookings-nudge ${res.status}`);
  } catch (err) {
    console.warn("[calendar-scheduler] bookings-nudge failed:", err);
  }
}

function shouldFireBriefing(): boolean {
  let settings;
  try {
    settings = getSettings();
  } catch {
    return false;
  }
  if (!settings.morning_briefing_enabled) return false;
  if (settings.home_lat == null || settings.home_lon == null) return false;

  const tz = settings.home_timezone || "America/Sao_Paulo";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = parseInt(parts.hour as string, 10);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (hour !== BRIEFING_HOUR) return false;
  if (lastBriefingFireDate === date) return false;
  lastBriefingFireDate = date;
  return true;
}

async function tickMorningBriefing() {
  if (!shouldFireBriefing()) return;
  const token = getServiceToken();
  if (!token) {
    console.warn("[calendar-scheduler] morning-briefing skipped: no service token");
    return;
  }
  try {
    const res = await fetch(`${baseUrl()}/api/agent/morning-briefing`, {
      method: "POST",
      headers: { "x-openclaw-token": token },
      cache: "no-store",
    });
    if (!res.ok) console.warn(`[calendar-scheduler] morning-briefing ${res.status}`);
  } catch (err) {
    console.warn("[calendar-scheduler] morning-briefing failed:", err);
  }
}

export function startCalendarScheduler(): void {
  if (started) return;
  started = true;
  console.log(
    "[calendar-scheduler] iniciando — reminders 60s, nudge 30min, briefing diário 07:00 (TZ do usuário)"
  );
  // Staggered initial delays to avoid colliding on startup
  setTimeout(() => {
    void tickReminders();
    setInterval(() => void tickReminders(), REMINDER_INTERVAL_MS);
  }, 5_000);
  setTimeout(() => {
    void tickBookingsNudge();
    setInterval(() => void tickBookingsNudge(), BOOKINGS_NUDGE_INTERVAL_MS);
  }, 15_000);
  setTimeout(() => {
    setInterval(() => void tickMorningBriefing(), BRIEFING_CHECK_INTERVAL_MS);
  }, 10_000);
}

export function isCalendarSchedulerStarted(): boolean {
  return started;
}
