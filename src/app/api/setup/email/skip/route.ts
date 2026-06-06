/**
 * Mark the email step of the welcome wizard as "skipped" so setup can
 * complete without an IMAP account configured.
 *
 * POST /api/setup/email/skip   → { skipped: true }
 * POST /api/setup/email/skip?reset=1 → { skipped: false } (lets user reopen the step)
 */
import { NextRequest, NextResponse } from "next/server";
import { setSettings } from "@/lib/memory-db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  const next = setSettings({ setup_email_skipped: !reset });
  return NextResponse.json({ skipped: next.setup_email_skipped });
}
