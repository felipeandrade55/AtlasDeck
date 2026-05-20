import { NextRequest, NextResponse } from "next/server";
import { listDueReminders, markReminderSent } from "@/lib/calendar-db";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildTelegramMessage(title: string, startIso: string, minutesBefore: number, location: string | null): string {
  const time = fmtTime(startIso);
  const date = new Date(startIso).toLocaleDateString("pt-BR");
  const locationLine = location ? `\n📍 ${location}` : "";
  const window =
    minutesBefore === 0
      ? "agora"
      : minutesBefore < 60
        ? `em ${minutesBefore} minutos`
        : `em ${Math.round(minutesBefore / 60)}h`;
  return `<b>⏰ Lembrete de Compromisso</b>\n\n<b>${title}</b>\n🗓️ ${date} às ${time} (${window})${locationLine}`;
}

export async function POST(_request: NextRequest) {
  try {
    const now = new Date();
    const due = listDueReminders(now);

    let dispatched = 0;
    let failed = 0;

    for (const reminder of due) {
      try {
        if (reminder.channel === "notification") {
          await addNotification(
            "Lembrete de compromisso",
            `${reminder.event_title} — ${fmtTime(reminder.event_start_at)}`,
            "info",
            `/calendar?event=${reminder.event_id}`,
            { event_id: reminder.event_id, minutes_before: reminder.minutes_before }
          );
        } else if (reminder.channel === "telegram") {
          await sendTelegramAlert(
            "",
            "",
            buildTelegramMessage(
              reminder.event_title,
              reminder.event_start_at,
              reminder.minutes_before,
              reminder.event_location
            )
          );
        }

        markReminderSent(reminder.reminder_id);
        dispatched++;
      } catch (err) {
        console.error("Failed to dispatch reminder", reminder.reminder_id, err);
        failed++;
      }
    }

    return NextResponse.json({
      success: true,
      due: due.length,
      dispatched,
      failed,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error("reminders/dispatch failed:", error);
    return NextResponse.json({ error: "Failed to dispatch reminders" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
