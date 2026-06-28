/**
 * GET /api/setup/ai-provider/oauth/poll
 *
 * Returns the current device-code OAuth session snapshot. The wizard polls
 * this while the user authorizes in their browser; status flips to "success"
 * once OpenClaw saves the auth profile (and we set ai_oauth_provider).
 */
import { NextResponse } from "next/server";
import { getOAuthSnapshot } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  const snap = getOAuthSnapshot();
  if (!snap) {
    return NextResponse.json({ status: "idle" });
  }
  return NextResponse.json(snap);
}
