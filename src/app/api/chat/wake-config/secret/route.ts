/**
 * GET /api/chat/wake-config/secret -> returns the raw Porcupine access
 * key so the browser can initialise the wake-word engine.
 *
 * Porcupine runs entirely client-side; the key has to reach the
 * browser for the SDK to authenticate. This endpoint sits behind the
 * same auth as the rest of /api/* so only the logged-in operator can
 * read it.
 */
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const envKey = process.env.PORCUPINE_ACCESS_KEY?.trim() || null;
  const s = getSettings();
  const accessKey = envKey || s.porcupine_access_key || null;
  if (!accessKey) {
    return NextResponse.json(
      { error: "Porcupine access key nao configurada" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    accessKey,
    keyword: s.porcupine_keyword || "Jarvis",
  });
}
