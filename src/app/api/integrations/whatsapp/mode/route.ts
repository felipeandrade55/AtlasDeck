/**
 * POST /api/integrations/whatsapp/mode
 *
 * Simple, agent-friendly endpoint to flip the WhatsApp operation mode
 * without touching every other field in the full PUT /api/integrations/
 * whatsapp payload. Designed so the user can tell the Telegram/chat
 * agent "passa o WhatsApp para modo passivo" and the agent does:
 *
 *   curl -X POST http://localhost:3000/api/integrations/whatsapp/mode \
 *     -H 'Content-Type: application/json' \
 *     -d '{"mode":"passive"}'
 *
 * Accepted modes:
 *   - "passive"   — bot connected but never replies (default + safe)
 *   - "owner"     — replies in first person as the owner
 *   - "assistant" — replies in third person as the owner's assistant
 *   - "open"      — replies in the agent's default voice
 *   - "pairing"   — legacy mode (sends pairing code to unknown senders)
 *
 * Returns the applied `dmPolicy` and `messagePrefix` so the agent can
 * confirm what changed back to the user.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import {
  operationModeToChannelConfig,
  setWhatsappAccountLocal,
  type WhatsappOperationMode,
} from "@/lib/whatsapp-accounts-local";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

const VALID_MODES: WhatsappOperationMode[] = [
  "passive",
  "owner",
  "assistant",
  "open",
  "pairing",
];

export async function POST(req: NextRequest) {
  let body: { mode?: string; accountId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const mode = (body.mode || "").trim() as WhatsappOperationMode;
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json(
      {
        error: `mode inválido. Use um destes: ${VALID_MODES.join(", ")}`,
        accepted: VALID_MODES,
      },
      { status: 400 },
    );
  }

  const accountId = (body.accountId || "main").trim();

  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const raw = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf-8"))
      : {};

    if (!raw.channels || typeof raw.channels !== "object") raw.channels = {};
    const wa =
      raw.channels.whatsapp && typeof raw.channels.whatsapp === "object"
        ? (raw.channels.whatsapp as Record<string, unknown>)
        : {};

    const applied = operationModeToChannelConfig(mode);
    wa.dmPolicy = applied.dmPolicy;
    if (applied.messagePrefix) wa.messagePrefix = applied.messagePrefix;
    else delete wa.messagePrefix;
    wa.selfChatMode = applied.selfChatMode;
    wa.groupPolicy = applied.groupPolicy;
    if (applied.groupAllowFrom.length > 0) wa.groupAllowFrom = applied.groupAllowFrom;
    else delete wa.groupAllowFrom;
    raw.channels.whatsapp = wa;

    writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    setWhatsappAccountLocal(accountId, { operationMode: mode });

    try {
      logActivity(
        "config",
        `WhatsApp modo de operação alterado para "${mode}" (conta: ${accountId})`,
        "success",
        { metadata: { mode, accountId, dmPolicy: applied.dmPolicy } },
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      mode,
      accountId,
      applied,
      hint:
        "Reinicie o gateway para o novo modo ser aplicado. Use POST /api/recovery/action com {action:'gateway-restart'} ou o botão Reparar config no modal.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    accepted: VALID_MODES,
    descriptions: {
      passive: "Bot conectado, mas nunca responde (default seguro).",
      owner: "Responde como você, primeira pessoa, tom direto.",
      assistant: "Responde como seu assessor, terceira pessoa, formal.",
      open: "Responde com a voz padrão do agente (sem persona).",
      pairing: "Envia pairing code para desconhecidos (LEGADO — evite).",
    },
  });
}
