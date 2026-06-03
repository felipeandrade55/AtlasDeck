/**
 * Boot-time background ingester for the WhatsApp briefing. Keeps the briefing
 * DB fresh from OpenClaw session transcripts even when no one has the dashboard
 * open (so the dashboard card + notifications reflect reality). The page/card
 * also trigger a sync-on-read, so this scheduler is the belt to that's
 * suspenders — but it's what makes the audit trail accumulate passively.
 *
 * Mirrors learner-scheduler.ts: single timer, re-entrancy guard, env kill
 * switch, unref'd so it never holds the process open.
 */
import { ingestWhatsappBriefings } from "./whatsapp-briefing-ingester";
import { getBriefingCountBySource } from "./whatsapp-briefing-db";

const INTERVAL_MS = Number.parseInt(
  process.env.WHATSAPP_BRIEFING_INTERVAL_MS || `${10 * 60 * 1000}`, // every 10 min
  10,
);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = ingestWhatsappBriefings();
    if (r.inserted > 0 || process.env.WHATSAPP_BRIEFING_DEBUG === "1") {
      const counts = getBriefingCountBySource();
      console.log(
        `[whatsapp-briefing-scheduler] +${r.inserted} new (${r.deduped} dup) from ` +
          `${r.filesProcessed}/${r.whatsappFiles} files; total transcript=${counts.transcript}`,
      );
    }
  } catch (err) {
    console.warn("[whatsapp-briefing-scheduler] tick failed:", err);
  } finally {
    running = false;
  }
}

export function startWhatsappBriefingScheduler(): void {
  if (process.env.WHATSAPP_BRIEFING_INGEST_DISABLED === "1") {
    console.log("[whatsapp-briefing-scheduler] disabled via env");
    return;
  }
  if (timer) return; // already started (both instrumentation files may call us)
  // First backfill after 90s so we don't fight other boot work; then cadence.
  setTimeout(() => {
    void tick();
  }, 90_000);
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[whatsapp-briefing-scheduler] started (interval=${INTERVAL_MS}ms)`);
}

export function stopWhatsappBriefingScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
