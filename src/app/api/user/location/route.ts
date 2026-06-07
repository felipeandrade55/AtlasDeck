import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings, upsertMemory } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

const LOCATION_MEMORY_TITLE = "Localização da residência do usuário";
const LOCATION_MEMORY_WORKSPACE = "workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

function formatAddressLine(parts: {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): string | null {
  const segments: string[] = [];
  if (parts.street) {
    segments.push(parts.number ? `${parts.street}, ${parts.number}` : parts.street);
  }
  if (parts.complement) segments.push(parts.complement);
  if (parts.neighborhood) segments.push(parts.neighborhood);
  if (parts.city) {
    segments.push(parts.state ? `${parts.city} - ${parts.state}` : parts.city);
  } else if (parts.state) {
    segments.push(parts.state);
  }
  if (parts.postal_code) segments.push(`CEP ${parts.postal_code}`);
  return segments.length ? segments.join(", ") : null;
}

export async function GET() {
  const s = getSettings();
  return NextResponse.json({
    lat: s.home_lat,
    lon: s.home_lon,
    label: s.home_label,
    timezone: s.home_timezone,
    updated_at: s.home_updated_at,
    address: {
      street: s.home_address_street,
      number: s.home_address_number,
      complement: s.home_address_complement,
      neighborhood: s.home_address_neighborhood,
      city: s.home_address_city,
      state: s.home_address_state,
      postal_code: s.home_address_postal_code,
      reference: s.home_address_reference,
    },
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
  const label = trimOrNull(body.label);
  const timezone = trimOrNull(body.timezone);

  if (lat === null || lon === null) {
    return NextResponse.json({ error: "lat and lon required (numbers)" }, { status: 400 });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json({ error: "lat/lon out of range" }, { status: 400 });
  }

  // Address is one optional object. Each field is independently optional —
  // we never reject a save because the user filled only some of them.
  const addr = (body.address ?? {}) as Record<string, unknown>;
  const addressPatch = {
    home_address_street: trimOrNull(addr.street),
    home_address_number: trimOrNull(addr.number),
    home_address_complement: trimOrNull(addr.complement),
    home_address_neighborhood: trimOrNull(addr.neighborhood),
    home_address_city: trimOrNull(addr.city),
    home_address_state: trimOrNull(addr.state),
    home_address_postal_code: trimOrNull(addr.postal_code),
    home_address_reference: trimOrNull(addr.reference),
  };

  const updated = setSettings({
    home_lat: lat,
    home_lon: lon,
    home_label: label,
    home_timezone: timezone,
    home_updated_at: new Date().toISOString(),
    ...addressPatch,
  });

  logActivity(
    'config',
    label ? `Localização atualizada: ${label}` : `Localização atualizada: ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    'success',
    { metadata: { lat, lon, label, timezone } }
  );

  // Mirror as a pinned identity memory so RAG / agent prompts surface it
  // naturally. Includes the full street address when present so Jarvis can
  // recall delivery details without needing to hit the location API.
  try {
    const friendly = label?.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const fullAddress = formatAddressLine({
      street: addressPatch.home_address_street,
      number: addressPatch.home_address_number,
      complement: addressPatch.home_address_complement,
      neighborhood: addressPatch.home_address_neighborhood,
      city: addressPatch.home_address_city,
      state: addressPatch.home_address_state,
      postal_code: addressPatch.home_address_postal_code,
    });
    const lines: Array<string | null> = [
      `O usuário mora em: ${friendly}.`,
      `Coordenadas (lat, lon): ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
      timezone ? `Fuso horário: ${timezone}.` : null,
      fullAddress ? `Endereço completo para entregas: ${fullAddress}.` : null,
      addressPatch.home_address_reference
        ? `Ponto de referência: ${addressPatch.home_address_reference}.`
        : null,
      `Use esta localização para personalizar contexto, previsão do tempo, sugestões e — quando aplicável — entregas/pedidos.`,
    ];
    upsertMemory({
      workspace: LOCATION_MEMORY_WORKSPACE,
      type: "identity",
      title: LOCATION_MEMORY_TITLE,
      content: lines.filter(Boolean).join(" "),
      summary: fullAddress ? `Mora em ${fullAddress}` : `Mora em ${friendly}`,
      source: "manual",
      tags: ["location", "user-profile", "home", "delivery"],
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
    address: {
      street: updated.home_address_street,
      number: updated.home_address_number,
      complement: updated.home_address_complement,
      neighborhood: updated.home_address_neighborhood,
      city: updated.home_address_city,
      state: updated.home_address_state,
      postal_code: updated.home_address_postal_code,
      reference: updated.home_address_reference,
    },
  });
}

export async function DELETE() {
  setSettings({
    home_lat: null,
    home_lon: null,
    home_label: null,
    home_timezone: null,
    home_updated_at: null,
    home_address_street: null,
    home_address_number: null,
    home_address_complement: null,
    home_address_neighborhood: null,
    home_address_city: null,
    home_address_state: null,
    home_address_postal_code: null,
    home_address_reference: null,
  });
  logActivity('config', 'Localização removida', 'success');
  return NextResponse.json({ ok: true });
}
