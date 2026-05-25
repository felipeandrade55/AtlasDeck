/**
 * Start Telegram pairing for the welcome wizard.
 *
 * 1. Validates the bot token via getMe()
 * 2. Clears any active webhook (so getUpdates can poll)
 * 3. Creates an in-memory pairing nonce
 * 4. Returns the deep link + a QR code (server-side rendered SVG)
 */
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { createPairing } from "@/lib/telegram-pairing";

export const dynamic = "force-dynamic";

const TG_TIMEOUT_MS = 6000;

async function tgCall<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    return { ok: !!data.ok, result: data.result, description: data.description };
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface Body {
  botToken: string;
  accountId?: string;
}

interface MeResult {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const token = (body.botToken ?? "").trim();
  const accountId = (body.accountId ?? "main").trim() || "main";
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return NextResponse.json(
      { error: "Token Telegram inválido (formato esperado: 123456:ABC-DEF...)" },
      { status: 400 },
    );
  }

  const me = await tgCall<MeResult>(token, "getMe");
  if (!me.ok || !me.result) {
    return NextResponse.json(
      { error: `getMe falhou: ${me.description ?? "resposta inválida"}` },
      { status: 400 },
    );
  }
  const username = me.result.username;
  if (!username) {
    return NextResponse.json(
      { error: "O bot precisa ter @username (configure no @BotFather)" },
      { status: 400 },
    );
  }

  // Webhooks bloqueiam getUpdates — desliga em silêncio se houver
  await tgCall(token, "deleteWebhook", { drop_pending_updates: false });

  const { nonce, expiresAt } = createPairing({
    botToken: token,
    botUsername: username,
    accountId,
  });

  const deepLink = `https://t.me/${username}?start=${nonce}`;
  const qrSvg = await QRCode.toString(deepLink, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    width: 256,
  });

  return NextResponse.json({
    nonce,
    expiresAt,
    botUsername: username,
    botFirstName: me.result.first_name,
    deepLink,
    qrSvg,
  });
}
