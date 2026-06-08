import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createBookingLink, listBookingLinks } from "@/lib/calendar-db";
import { logActivity } from "@/lib/activities-db";
import { buildBookingUrl, isPublicBaseShareable } from "@/lib/public-url";
import type { BookingLink } from "@/lib/calendar-types";

export const dynamic = "force-dynamic";

function generateToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/** Attach the full, shareable public URL so callers (UI + agent) don't each
 *  rebuild it from the token. */
function withPublicUrl(link: BookingLink) {
  return { ...link, publicUrl: buildBookingUrl(link.token) };
}

export async function GET() {
  try {
    const links = listBookingLinks().map(withPublicUrl);
    return NextResponse.json({ links, shareable: isPublicBaseShareable() });
  } catch (error) {
    console.error("Failed to list booking links:", error);
    return NextResponse.json({ error: "Failed to list links" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.title || typeof body.duration_minutes !== "number") {
      return NextResponse.json({ error: "Missing title or duration_minutes" }, { status: 400 });
    }
    const link = createBookingLink({
      token: generateToken(),
      title: body.title,
      duration_minutes: body.duration_minutes,
      description: body.description ?? null,
      expires_at: body.expires_at ?? null,
      max_uses: body.max_uses ?? null,
      active: body.active !== false,
    });
    try {
      logActivity(
        "calendar",
        `Link de agendamento criado: ${link.title} (${link.duration_minutes}min)`,
        "success",
        { metadata: { linkId: link.id, token: link.token } }
      );
    } catch {}
    return NextResponse.json(
      { link: withPublicUrl(link), shareable: isPublicBaseShareable() },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to create booking link:", error);
    return NextResponse.json({ error: "Failed to create link" }, { status: 500 });
  }
}
