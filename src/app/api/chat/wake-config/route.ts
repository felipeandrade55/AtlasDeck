/**
 * GET   /api/chat/wake-config -> Porcupine wake-word configuration status
 * PATCH /api/chat/wake-config -> persists Porcupine access key + keyword
 *
 * Browser-friendly: GET never returns the full access key, only a
 * head/tail preview so the UI can confirm what is saved.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings } from "@/lib/memory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_KEYWORDS = [
  "Alexa",
  "Americano",
  "Blueberry",
  "Bumblebee",
  "Computer",
  "Grapefruit",
  "Grasshopper",
  "Hey Google",
  "Hey Siri",
  "Jarvis",
  "Okay Google",
  "Picovoice",
  "Porcupine",
  "Terminator",
] as const;

function preview(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export async function GET() {
  const envKey = process.env.PORCUPINE_ACCESS_KEY?.trim() || null;
  const s = getSettings();
  const accessKey = envKey || s.porcupine_access_key;
  return NextResponse.json({
    configured: !!accessKey,
    accessKeyPreview: preview(accessKey),
    source: envKey ? "env" : s.porcupine_access_key ? "memory_settings" : null,
    keyword: s.porcupine_keyword || "Jarvis",
    availableKeywords: VALID_KEYWORDS,
  });
}

interface PatchBody {
  accessKey?: string | null;
  keyword?: string | null;
}

export async function PATCH(req: NextRequest) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, string | null> = {};
  if (body.accessKey !== undefined) {
    const v = body.accessKey?.trim();
    patch.porcupine_access_key = v && v.length > 0 ? v : null;
  }
  if (body.keyword !== undefined) {
    const v = body.keyword?.trim();
    if (v && (VALID_KEYWORDS as readonly string[]).includes(v)) {
      patch.porcupine_keyword = v;
    } else if (v === "" || v === null) {
      patch.porcupine_keyword = "Jarvis";
    } else {
      return NextResponse.json(
        { error: `Keyword must be one of: ${VALID_KEYWORDS.join(", ")}` },
        { status: 400 },
      );
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Empty patch" }, { status: 400 });
  }

  setSettings(patch);
  return GET();
}
