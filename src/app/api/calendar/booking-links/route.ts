import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createBookingLink, listBookingLinks } from "@/lib/calendar-db";

export const dynamic = "force-dynamic";

function generateToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export async function GET() {
  try {
    const links = listBookingLinks();
    return NextResponse.json({ links });
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
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    console.error("Failed to create booking link:", error);
    return NextResponse.json({ error: "Failed to create link" }, { status: 500 });
  }
}
