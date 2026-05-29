/**
 * WhatsApp integration — detailed status + edit + test.
 * Modeled after telegram integration to guarantee parity.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getActivities, logActivity } from "@/lib/activities-db";
import {
  getWhatsappAccountLocal,
  setWhatsappAccountLocal,
  deleteWhatsappAccountLocal,
  migrateWhatsappAccountsFromConfig,
} from "@/lib/whatsapp-accounts-local";
import { waCall, hasWhatsappSessionLocal } from "@/lib/whatsapp-api";

export const dynamic = "force-dynamic";

type DmPolicy = "pairing" | "open" | "off" | string;

interface WhatsappAccountConfig {
  token?: string;
  phoneNumber?: string;
  chatId?: string;
  dmPolicy?: DmPolicy;
  [k: string]: unknown;
}

interface WhatsappChannelConfig {
  enabled?: boolean;
  dmPolicy?: DmPolicy;
  accounts?: Record<string, WhatsappAccountConfig>;
  [k: string]: unknown;
}

interface OpenClawJson {
  channels?: {
    whatsapp?: WhatsappChannelConfig;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length > 12) {
    return `${token.slice(0, 6)}…${token.slice(-6)}`;
  }
  return "•".repeat(token.length);
}

function readConfig(): { path: string; isFallback: boolean; raw: OpenClawJson } {
  const { path: configPath, isFallback } = resolveOpenClawAgentsConfigPath();
  let raw: OpenClawJson = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      throw new Error(`openclaw.json inválido (${configPath}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { path: configPath, isFallback, raw };
}

function writeConfig(raw: OpenClawJson, path: string) {
  writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
}

// ─── GET ─────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const includeLive = url.searchParams.get("live") !== "0";
    const revealToken = url.searchParams.get("revealToken") === "1";

    const { path: configPath, isFallback, raw } = readConfig();

    if (migrateWhatsappAccountsFromConfig(raw)) {
      try {
        writeConfig(raw, configPath);
        logActivity(
          "config",
          "Migração: chatId do WhatsApp movido para storage local",
          "success",
          { metadata: { configPath } },
        );
      } catch (e) {
        console.error("Failed to persist whatsapp accounts migration:", e);
      }
    }

    const wa: WhatsappChannelConfig = (raw.channels?.whatsapp as WhatsappChannelConfig | undefined) || {};
    const accountsRaw = wa.accounts || {};

    type AccountOut = {
      id: string;
      hasToken: boolean;
      tokenMasked: string;
      token: string | null;
      phoneNumber: string | null;
      chatId: string | null;
      dmPolicy: DmPolicy | null;
      sessionStatus: "connected" | "disconnected" | "authenticating";
      diagnostics: null | {
        connected: boolean;
        error?: string;
      };
    };

    const accounts: AccountOut[] = [];

    for (const [id, acct] of Object.entries(accountsRaw)) {
      const token = typeof acct.token === "string" ? acct.token.trim() : "";
      const hasToken = !!token && token !== "configured_mock_token";
      const legacyPhoneNumber = typeof acct.phoneNumber === "string" ? acct.phoneNumber.trim() : "";

      let diagnostics: AccountOut["diagnostics"] = null;
      let sessionStatus: AccountOut["sessionStatus"] = "disconnected";

      const localSessionExists = hasWhatsappSessionLocal(id);

      if (includeLive && hasToken) {
        const check = await waCall<{ success: boolean; sessionStatus?: string }>(
          "https://api.meta.com/v16.0/me",
          "GET",
          token
        );
        if (check.ok) {
          sessionStatus = "connected";
          diagnostics = { connected: true };
        } else {
          sessionStatus = "disconnected";
          diagnostics = {
            connected: false,
            error: check.description || check.networkError,
          };
        }
      } else {
        if (localSessionExists) {
          sessionStatus = "connected";
          diagnostics = { connected: true };
        } else {
          sessionStatus = "disconnected";
          diagnostics = {
            connected: false,
            error: "Sessão do WhatsApp Web não iniciada (QR Code não escaneado)",
          };
        }
      }

      const localData = getWhatsappAccountLocal(id);
      const localChatId = localData.chatId;
      const localDmPolicy = localData.dmPolicy;
      const localPhoneNumber = localData.phoneNumber;
      const legacyChatId = typeof acct.chatId === "string" && acct.chatId.trim() ? acct.chatId.trim() : null;
      const legacyDmPolicy = typeof acct.dmPolicy === "string" && acct.dmPolicy.trim() ? acct.dmPolicy.trim() : null;

      accounts.push({
        id,
        hasToken,
        tokenMasked: hasToken ? maskToken(token) : "",
        token: hasToken && revealToken ? token : null,
        phoneNumber: localPhoneNumber || legacyPhoneNumber || null,
        chatId: localChatId || legacyChatId,
        dmPolicy: (localDmPolicy || legacyDmPolicy || wa.dmPolicy || "pairing") as DmPolicy,
        sessionStatus,
        diagnostics,
      });
    }

    // Recent activity (whatsapp-tagged)
    let recentActivity: Array<{ timestamp: string; status: string; description: string }> = [];
    try {
      const acts = getActivities({ search: "WhatsApp", limit: 10, sort: "newest" });
      recentActivity = acts.activities.map((a) => ({
        timestamp: a.timestamp,
        status: a.status,
        description: a.description,
      }));
    } catch {}

    const issues: string[] = [];
    if (!wa.enabled) issues.push("channels.whatsapp.enabled = false (canal desabilitado)");
    if (accounts.length === 0) issues.push("Nenhuma conta de WhatsApp configurada em channels.whatsapp.accounts");
    for (const a of accounts) {
      const localSessionExists = hasWhatsappSessionLocal(a.id);
      if (!a.hasToken && !localSessionExists) {
        issues.push(`Conta "${a.id}": token de acesso ou sessão local ausente`);
      }
      if (!a.phoneNumber) issues.push(`Conta "${a.id}": número de telefone de origem não definido`);
      if (a.diagnostics && !a.diagnostics.connected) {
        issues.push(`Conta "${a.id}": falha ao conectar à API — ${a.diagnostics.error}`);
      }
      if (!a.chatId) issues.push(`Conta "${a.id}": chatId não definido — alertas não conseguirão enviar mensagens proativas`);
    }

    const healthy = issues.length === 0 && accounts.length > 0;

    return NextResponse.json({
      config: {
        path: configPath,
        isFallback,
        enabled: !!wa.enabled,
        dmPolicy: wa.dmPolicy ?? "pairing",
      },
      accounts,
      recentActivity,
      summary: { healthy, issues, issueCount: issues.length },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// ─── PUT ─────────────────────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  let body: {
    enabled?: boolean;
    dmPolicy?: DmPolicy;
    accounts?: Record<string, { token?: string; phoneNumber?: string; chatId?: string; dmPolicy?: DmPolicy }>;
    deleteAccountIds?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  try {
    const { path: configPath, raw } = readConfig();
    if (!raw.channels) raw.channels = {};
    const wa = ((raw.channels.whatsapp as WhatsappChannelConfig | undefined) ||
      ({ dmPolicy: "pairing", accounts: {} } as WhatsappChannelConfig));
    if (!wa.accounts) wa.accounts = {};

    if (typeof body.enabled === "boolean") wa.enabled = body.enabled;
    if (typeof body.dmPolicy === "string" && body.dmPolicy) wa.dmPolicy = body.dmPolicy;

    if (body.accounts) {
      for (const [id, patch] of Object.entries(body.accounts)) {
        const cleanId = id.trim();
        if (!cleanId) continue;

        // OpenClaw 2026.5.12+ rejects every field we used to write inside
        // channels.whatsapp.accounts.<id> (token/phoneNumber/chatId/dmPolicy)
        // with "must NOT have additional properties", killing the gateway
        // and blocking `channels login` from generating a QR code. We keep
        // the account entry as an empty `{}` so OpenClaw knows the ID
        // exists, and route every UI-managed field to local storage.
        if (typeof patch.phoneNumber === "string") {
          setWhatsappAccountLocal(cleanId, { phoneNumber: patch.phoneNumber });
        }
        if (typeof patch.dmPolicy === "string") {
          setWhatsappAccountLocal(cleanId, { dmPolicy: patch.dmPolicy });
        }
        if (typeof patch.chatId === "string") {
          setWhatsappAccountLocal(cleanId, { chatId: patch.chatId });
        }

        wa.accounts[cleanId] = {};
      }
    }

    if (body.deleteAccountIds && Array.isArray(body.deleteAccountIds)) {
      for (const id of body.deleteAccountIds) {
        if (typeof id === "string" && wa.accounts[id]) delete wa.accounts[id];
        if (typeof id === "string") deleteWhatsappAccountLocal(id);
      }
    }

    raw.channels.whatsapp = wa;
    writeConfig(raw, configPath);

    return NextResponse.json({ success: true, configPath });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// ─── POST (actions) ──────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  let body: { accountId?: string; chatId?: string; message?: string; token?: string; phoneNumber?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK
  }

  const accountId = (body.accountId || "main").trim();

  try {
    const { raw } = readConfig();
    const acct = (raw.channels?.whatsapp as WhatsappChannelConfig | undefined)?.accounts?.[accountId];
    const bodyToken = typeof body.token === "string" ? body.token.trim() : "";
    const savedToken = typeof acct?.token === "string" ? acct.token.trim() : "";
    const token = bodyToken || savedToken;
    const hasToken = !!token && token !== "configured_mock_token";

    if (action === "test") {
      const localChatId = getWhatsappAccountLocal(accountId).chatId;
      const legacyChatId = typeof acct?.chatId === "string" ? acct.chatId : "";
      const chatId = (body.chatId || localChatId || legacyChatId || "").trim();
      if (!chatId) {
        return NextResponse.json(
          { error: `chatId não fornecido para "${accountId}"` },
          { status: 400 },
        );
      }

      if (!hasToken) {
        if (hasWhatsappSessionLocal(accountId)) {
          return NextResponse.json({
            success: true,
            sentTo: chatId,
            isLocal: true,
            message: "Sessão local do WhatsApp Web (Baileys) está ativa e conectada! Como você está usando uma sessão local, envie uma mensagem diretamente para o seu bot pelo WhatsApp para testar a conversa (o envio automático a partir do painel é exclusivo para a API em Nuvem com Token).",
          });
        } else {
          return NextResponse.json(
            { error: `Sessão local do WhatsApp Web deslogada. Por favor, acesse as configurações e escaneie o QR Code primeiro.` },
            { status: 400 },
          );
        }
      }

      const message =
        body.message ||
        `*✅ Teste do WhatsApp AtlasDeck*\nSe você está lendo isto, a conexão WhatsApp da conta *${accountId}* está funcionando.\n\n_${new Date().toLocaleString("pt-BR")}_`;

      const r = await waCall(
        "https://api.meta.com/v16.0/messages",
        "POST",
        token,
        {
          messaging_product: "whatsapp",
          to: chatId,
          type: "text",
          text: { body: message },
        }
      );

      if (!r.ok) {
        return NextResponse.json({
          success: false,
          error: r.description || r.networkError || `HTTP ${r.httpStatus ?? "?"}`,
        });
      }
      return NextResponse.json({ success: true, sentTo: chatId });
    }

    if (!hasToken) {
      return NextResponse.json(
        { error: `Conta "${accountId}" sem token de acesso` },
        { status: 400 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
