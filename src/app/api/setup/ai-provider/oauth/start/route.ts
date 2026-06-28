/**
 * POST /api/setup/ai-provider/oauth/start
 *
 * Kicks off the OpenAI device-code OAuth flow via OpenClaw. Waits briefly for
 * the verification URL + user code to appear in the CLI output, then returns a
 * snapshot. The client polls /poll afterwards until status === "success".
 */
import { NextResponse } from "next/server";
import { startOpenAiDeviceLogin, getOAuthSnapshot } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let provider = "openai";
  try {
    const body = await req.json();
    if (body && typeof body.provider === "string" && body.provider.trim()) {
      provider = body.provider.trim();
    }
  } catch {
    // no body — use default provider
  }

  startOpenAiDeviceLogin({ provider });

  // Give the CLI up to ~12s to print the device URL/code before responding,
  // so the wizard can show them immediately on the happy path.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const snap = getOAuthSnapshot();
    if (snap && (snap.verificationUrl || snap.status === "error" || snap.status === "success")) {
      return NextResponse.json(snap);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return NextResponse.json(
    getOAuthSnapshot() ?? { status: "error", error: "Sem resposta do OpenClaw" },
  );
}
