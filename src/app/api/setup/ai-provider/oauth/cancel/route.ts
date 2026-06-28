/**
 * POST /api/setup/ai-provider/oauth/cancel
 *
 * Aborts an in-flight device-code login (user backed out / wants to retry or
 * switch to an API key instead).
 */
import { NextResponse } from "next/server";
import { cancelOAuthSession } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST() {
  cancelOAuthSession();
  return NextResponse.json({ ok: true });
}
