/**
 * Agent context — consolidated snapshot for proactive messaging.
 *
 * Used by OpenClaw cron jobs (digest 21h, morning briefing 7h, etc.)
 * to build context-aware Telegram messages.
 *
 * GET /api/agent/context              — full payload
 * GET /api/agent/context?format=text  — human-readable bullets, ready to paste in a prompt
 */
import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WeatherSnapshot {
  city: string;
  temp: number;
  feels_like: number;
  humidity: number;
  wind: number;
  precipitation: number;
  rain_pct: number | null;
  condition: string;
  emoji: string;
  forecast: Array<{
    day: string;
    max: number;
    min: number;
    emoji: string;
    rain_pct: number | null;
    rain_mm: number | null;
  }>;
}

async function fetchWeather(request: NextRequest, lat: number, lon: number): Promise<WeatherSnapshot | null> {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(`${origin}/api/weather?lat=${lat}&lon=${lon}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as WeatherSnapshot;
  } catch {
    return null;
  }
}

function buildAdvisories(w: WeatherSnapshot | null): string[] {
  if (!w) return [];
  const out: string[] = [];
  const today = w.forecast?.[0];
  const tomorrow = w.forecast?.[1];

  if ((w.rain_pct ?? 0) >= 60) {
    out.push(`Chuva provável agora (${w.rain_pct}%) — leve guarda-chuva se for sair.`);
  } else if (today && (today.rain_pct ?? 0) >= 60) {
    out.push(`Hoje há ${today.rain_pct}% de chance de chuva${today.rain_mm ? ` (${today.rain_mm} mm)` : ""} — considere levar guarda-chuva.`);
  }
  if (tomorrow && (tomorrow.rain_pct ?? 0) >= 70) {
    out.push(`Amanhã: ${tomorrow.rain_pct}% de chance de chuva.`);
  }
  if (today && today.min <= 12) {
    out.push(`Mínima de ${today.min}°C hoje — pegue um casaco.`);
  }
  if (today && today.max >= 34) {
    out.push(`Máxima de ${today.max}°C hoje — calor intenso, hidrate-se.`);
  }
  if (w.feels_like >= 36) {
    out.push(`Sensação térmica de ${w.feels_like}°C agora — calor extremo.`);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const settings = getSettings();
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format");

  const hasHome = settings.home_lat != null && settings.home_lon != null;
  const weather = hasHome
    ? await fetchWeather(request, settings.home_lat!, settings.home_lon!)
    : null;

  const now = new Date();
  const tz = settings.home_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayOfWeek = now.toLocaleDateString("pt-BR", { weekday: "long", timeZone: tz });
  const isWeekend = ["sábado", "domingo"].some((d) => dayOfWeek.toLowerCase().includes(d));

  const advisories = buildAdvisories(weather);

  const payload = {
    user: {
      home_label: settings.home_label,
      lat: settings.home_lat,
      lon: settings.home_lon,
      timezone: tz,
      configured: hasHome,
    },
    weather: weather
      ? {
          city: weather.city,
          now: {
            temp: weather.temp,
            feels_like: weather.feels_like,
            humidity: weather.humidity,
            wind: weather.wind,
            rain_pct: weather.rain_pct,
            condition: weather.condition,
            emoji: weather.emoji,
          },
          today: weather.forecast?.[0] ?? null,
          tomorrow: weather.forecast?.[1] ?? null,
          forecast: weather.forecast,
        }
      : null,
    datetime: {
      now: now.toISOString(),
      day_of_week: dayOfWeek,
      is_weekend: isWeekend,
      hour: parseInt(now.toLocaleString("pt-BR", { hour: "2-digit", hour12: false, timeZone: tz }), 10),
    },
    advisories,
  };

  if (format === "text") {
    const lines: string[] = [];
    lines.push(`# Contexto do usuário (${now.toLocaleString("pt-BR", { timeZone: tz })})`);
    if (hasHome) {
      lines.push(`- Localização: ${settings.home_label ?? `${settings.home_lat}, ${settings.home_lon}`}`);
    } else {
      lines.push(`- Localização: não configurada (peça ao usuário para configurar no dashboard)`);
    }
    if (weather) {
      lines.push(`- Clima agora: ${weather.emoji} ${weather.temp}°C (sensação ${weather.feels_like}°C), ${weather.condition.toLowerCase()}, ${weather.humidity}% umidade, vento ${weather.wind} km/h${weather.rain_pct != null ? `, chuva ${weather.rain_pct}%` : ""}`);
      const t = weather.forecast?.[0];
      const tm = weather.forecast?.[1];
      if (t) lines.push(`- Hoje: máx ${t.max}°C / mín ${t.min}°C${t.rain_pct != null ? ` — chuva ${t.rain_pct}%${t.rain_mm ? ` (${t.rain_mm} mm)` : ""}` : ""}`);
      if (tm) lines.push(`- Amanhã: máx ${tm.max}°C / mín ${tm.min}°C${tm.rain_pct != null ? ` — chuva ${tm.rain_pct}%` : ""}`);
    }
    lines.push(`- ${dayOfWeek}${isWeekend ? " (fim de semana)" : ""}`);
    if (advisories.length) {
      lines.push("");
      lines.push("## Recomendações para o briefing:");
      for (const a of advisories) lines.push(`- ${a}`);
    }
    return new NextResponse(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  return NextResponse.json(payload);
}
