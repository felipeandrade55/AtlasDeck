/**
 * Weather API - Madrid
 * GET /api/weather
 * Uses Open-Meteo (free, no API key)
 */
import { NextResponse } from 'next/server';

// Cache weather data for 10 minutes
let cache: { data: unknown; ts: number } | null = null;
const CACHE_DURATION = 10 * 60 * 1000;

const WMO_CODES: Record<number, { label: string; emoji: string }> = {
  0: { label: "Céu limpo", emoji: "☀️" },
  1: { label: "Predominantemente limpo", emoji: "🌤️" },
  2: { label: "Parcialmente nublado", emoji: "⛅" },
  3: { label: "Nublado", emoji: "☁️" },
  45: { label: "Neblina", emoji: "🌫️" },
  48: { label: "Neblina congelante", emoji: "🌫️" },
  51: { label: "Chuvisco leve", emoji: "🌦️" },
  53: { label: "Chuvisco", emoji: "🌦️" },
  55: { label: "Chuvisco forte", emoji: "🌧️" },
  61: { label: "Chuva leve", emoji: "🌧️" },
  63: { label: "Chuva", emoji: "🌧️" },
  65: { label: "Chuva forte", emoji: "🌧️" },
  71: { label: "Neve leve", emoji: "🌨️" },
  73: { label: "Neve", emoji: "❄️" },
  75: { label: "Neve forte", emoji: "❄️" },
  80: { label: "Pancadas leves", emoji: "🌦️" },
  81: { label: "Pancadas de chuva", emoji: "🌧️" },
  82: { label: "Pancadas fortes", emoji: "⛈️" },
  95: { label: "Tempestade", emoji: "⛈️" },
  96: { label: "Tempestade com granizo", emoji: "⛈️" },
  99: { label: "Tempestade com granizo forte", emoji: "⛈️" },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawLat = searchParams.get('lat');
  const rawLon = searchParams.get('lon');
  const hasCustomCoords = rawLat !== null && rawLon !== null;
  const defaultLat  = process.env.WEATHER_DEFAULT_LAT  ? parseFloat(process.env.WEATHER_DEFAULT_LAT)  : 40.4168;
  const defaultLon  = process.env.WEATHER_DEFAULT_LON  ? parseFloat(process.env.WEATHER_DEFAULT_LON)  : -3.7038;
  const defaultCity = process.env.WEATHER_DEFAULT_CITY || 'Madrid';
  const lat  = hasCustomCoords ? parseFloat(rawLat!)  : defaultLat;
  const lon  = hasCustomCoords ? parseFloat(rawLon!)  : defaultLon;
  const city = hasCustomCoords ? 'Local'              : defaultCity;

  // Return cache if valid (only for default location endpoint)
  if (!hasCustomCoords && cache && Date.now() - cache.ts < CACHE_DURATION) {
    return NextResponse.json(cache.data);
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum&timezone=auto&forecast_days=3`;

    const res = await fetch(url, { next: { revalidate: 600 } });
    const json = await res.json();

    const current = json.current;
    const daily = json.daily;

    const wmo = WMO_CODES[current.weather_code] || { label: "Unknown", emoji: "🌡️" };

    const data = {
      city,
      temp: Math.round(current.temperature_2m),
      feels_like: Math.round(current.apparent_temperature),
      humidity: current.relative_humidity_2m,
      wind: Math.round(current.wind_speed_10m),
      precipitation: current.precipitation,
      rain_pct: current.precipitation_probability ?? null,
      condition: wmo.label,
      emoji: wmo.emoji,
      forecast: daily.time.slice(0, 3).map((day: string, i: number) => ({
        day,
        max: Math.round(daily.temperature_2m_max[i]),
        min: Math.round(daily.temperature_2m_min[i]),
        emoji: (WMO_CODES[daily.weather_code[i]] || { emoji: "🌡️" }).emoji,
        rain_pct: daily.precipitation_probability_max?.[i] ?? null,
        rain_mm: daily.precipitation_sum?.[i] ?? null,
      })),
      updated: new Date().toISOString(),
    };

    if (!hasCustomCoords) cache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (error) {
    console.error('[weather] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch weather' }, { status: 500 });
  }
}
