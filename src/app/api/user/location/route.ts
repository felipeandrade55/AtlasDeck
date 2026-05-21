import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings, upsertMemory } from "@/lib/memory-db";

const LOCATION_MEMORY_TITLE = "Localização da residência do usuário";
const LOCATION_MEMORY_WORKSPACE = "workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = getSettings();
  return NextResponse.json({
    lat: s.home_lat,
    lon: s.home_lon,
    label: s.home_label,
    timezone: s.home_timezone,
    updated_at: s.home_updated_at,
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lat = typeof body.lat === "number" ? body.lat : null;
  const lon = typeof body.lon === "number" ? body.lon : null;
  const label = typeof body.label === "string" ? body.label.trim() : null;
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : null;

  if (lat === null || lon === null) {
    return NextResponse.json({ error: "lat and lon required (numbers)" }, { status: 400 });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json({ error: "lat/lon out of range" }, { status: 400 });
  }

  const updated = setSettings({
    home_lat: lat,
    home_lon: lon,
    home_label: label || null,
    home_timezone: timezone || null,
    home_updated_at: new Date().toISOString(),
  });

  // Mirror as a pinned identity memory so RAG / agent prompts surface it naturally
  try {
    const friendly = label?.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const content = [
      `O usuário mora em: ${friendly}.`,
      `Coordenadas (lat, lon): ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
      timezone ? `Fuso horário: ${timezone}.` : null,
      `Use esta localização para personalizar contexto, previsão do tempo e sugestões (ex: alertar sobre chuva antes de sair).`,
    ].filter(Boolean).join(" ");

    upsertMemory({
      workspace: LOCATION_MEMORY_WORKSPACE,
      type: "identity",
      title: LOCATION_MEMORY_TITLE,
      content,
      summary: `Mora em ${friendly}`,
      source: "manual",
      tags: ["location", "user-profile", "home"],
      importance: 0.95,
      pinned: true,
      language: "pt",
    });
  } catch (err) {
    console.warn("[user/location] failed to mirror to memory:", err);
  }

  return NextResponse.json({
    lat: updated.home_lat,
    lon: updated.home_lon,
    label: updated.home_label,
    timezone: updated.home_timezone,
    updated_at: updated.home_updated_at,
  });
}

export async function DELETE() {
  setSettings({
    home_lat: null,
    home_lon: null,
    home_label: null,
    home_timezone: null,
    home_updated_at: null,
  });
  return NextResponse.json({ ok: true });
}
