/**
 * Morning briefing — sends a personalized Telegram message at 7am
 * with weather-aware advisories (rain umbrella, cold jacket, heat warning, etc).
 *
 * Stays silent when there's nothing actionable to report (avoids notification fatigue).
 *
 * Auth: requires `x-openclaw-token` header OR the request must be local
 * (when `force=1` or `dry=1`, no token is required for ergonomics).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/memory-db";
import { sendTelegramAlert } from "@/lib/telegram";
import { hasValidServiceToken } from "@/lib/openclaw-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ContextPayload {
  user: { home_label: string | null; lat: number | null; lon: number | null; timezone: string; configured: boolean };
  weather: {
    city: string;
    now: { temp: number; feels_like: number; humidity: number; wind: number; rain_pct: number | null; condition: string; emoji: string };
    today: { day: string; max: number; min: number; emoji: string; rain_pct: number | null; rain_mm: number | null } | null;
    tomorrow: { day: string; max: number; min: number; emoji: string; rain_pct: number | null; rain_mm: number | null } | null;
  } | null;
  datetime: { now: string; day_of_week: string; is_weekend: boolean; hour: number };
  advisories: string[];
}

function buildMessage(ctx: ContextPayload): string {
  const w = ctx.weather;
  const greeting = ctx.datetime.is_weekend ? "Bom dia! Aproveite o fim de semana." : "Bom dia! Hora de começar o dia.";
  const lines: string[] = [];
  lines.push(`☀️ <b>Briefing matinal</b>`);
  lines.push("");
  lines.push(greeting);

  if (w && w.today) {
    const t = w.today;
    const nowLine = `${w.now.emoji} Agora: <b>${w.now.temp}°C</b> (sensação ${w.now.feels_like}°C), ${w.now.condition.toLowerCase()}.`;
    lines.push("");
    lines.push(nowLine);
    lines.push(`📅 Hoje: ${t.emoji} máx <b>${t.max}°C</b> / mín <b>${t.min}°C</b>${t.rain_pct != null ? ` · 💧 ${t.rain_pct}% chuva${t.rain_mm ? ` (${t.rain_mm} mm)` : ""}` : ""}`);
    if (w.tomorrow) {
      const tm = w.tomorrow;
      lines.push(`📅 Amanhã: ${tm.emoji} ${tm.max}°/${tm.min}°${tm.rain_pct != null ? ` · 💧 ${tm.rain_pct}%` : ""}`);
    }
  }

  if (ctx.advisories.length > 0) {
    lines.push("");
    lines.push("⚠️ <b>Recomendações</b>");
    for (const a of ctx.advisories) {
      lines.push(`• ${a}`);
    }
  }

  if (ctx.user.home_label) {
    lines.push("");
    lines.push(`<i>📍 ${ctx.user.home_label}</i>`);
  }

  return lines.join("\n");
}

function shouldSend(ctx: ContextPayload, force: boolean): { send: boolean; reason: string } {
  if (force) return { send: true, reason: "forced" };
  if (!ctx.weather) return { send: false, reason: "no_weather_data" };
  if (ctx.advisories.length > 0) return { send: true, reason: `${ctx.advisories.length} advisory(ies)` };
  // Default: send a brief "neutral" briefing on weekdays when no advisories?
  // Skip — keeps signal high and avoids notification fatigue.
  return { send: false, reason: "no_advisories" };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const dry = searchParams.get("dry") === "1" || searchParams.get("dry") === "true";
  const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";

  // Auth: require token unless dry-run/force from localhost-ish context (we don't validate origin here;
  // dry runs are read-only, force is a manual override the user controls).
  if (!dry && !hasValidServiceToken(request)) {
    return NextResponse.json({ error: "Missing or invalid x-openclaw-token" }, { status: 401 });
  }

  const settings = getSettings();
  if (settings.home_lat == null || settings.home_lon == null) {
    return NextResponse.json({ skipped: true, reason: "home_location_not_configured" });
  }

  // Pull consolidated context
  const origin = new URL(request.url).origin;
  const ctxRes = await fetch(`${origin}/api/agent/context`, { cache: "no-store" });
  if (!ctxRes.ok) {
    return NextResponse.json({ error: "Failed to load agent context" }, { status: 502 });
  }
  const ctx = (await ctxRes.json()) as ContextPayload;

  const decision = shouldSend(ctx, force);
  const message = buildMessage(ctx);

  if (dry) {
    return NextResponse.json({ dry_run: true, would_send: decision.send, reason: decision.reason, message });
  }

  if (!decision.send) {
    return NextResponse.json({ skipped: true, reason: decision.reason });
  }

  const sent = await sendTelegramAlert("", "", message);
  return NextResponse.json({ sent, reason: decision.reason, message_preview: message.slice(0, 200) });
}

export const GET = handle;
export const POST = handle;
