/**
 * Telegram integration — detailed status + edit + test.
 *
 * GET  /api/integrations/telegram        → full config + live diagnostics (getMe, getWebhookInfo, getUpdates)
 * PUT  /api/integrations/telegram        → upsert config (enabled, dmPolicy, accounts)
 * POST /api/integrations/telegram?action=test → send a test message via the chosen account
 * POST /api/integrations/telegram?action=clear-webhook → deleteWebhook (useful when polling stopped working)
 *
 * All persistence happens in OpenClaw's `openclaw.json` under `channels.telegram`,
 * the same file `/api/agents` and `lib/telegram.ts` already read from.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { getActivities } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

type DmPolicy = "pairing" | "open" | "off" | string;

interface TelegramAccountConfig {
  botToken?: string;
  chatId?: string;
  dmPolicy?: DmPolicy;
  [k: string]: unknown;
}

interface TelegramChannelConfig {
  enabled?: boolean;
  dmPolicy?: DmPolicy;
  accounts?: Record<string, TelegramAccountConfig>;
  [k: string]: unknown;
}

interface OpenClawJson {
  channels?: {
    telegram?: TelegramChannelConfig;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ─── Telegram Bot API helpers ────────────────────────────────────────────

const TG_TIMEOUT_MS = 6000;

async function tgCall<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; errorCode?: number; description?: string; httpStatus?: number; networkError?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const httpStatus = res.status;
    let data: { ok?: boolean; result?: T; error_code?: number; description?: string } = {};
    try {
      data = await res.json();
    } catch {
      return { ok: false, httpStatus, description: `Resposta não-JSON (HTTP ${httpStatus})` };
    }
    if (!data.ok) {
      return {
        ok: false,
        httpStatus,
        errorCode: data.error_code,
        description: data.description || `HTTP ${httpStatus}`,
      };
    }
    return { ok: true, result: data.result, httpStatus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, networkError: msg };
  } finally {
    clearTimeout(timer);
  }
}

function maskToken(token: string): string {
  if (!token) return "";
  const idx = token.indexOf(":");
  if (idx <= 0) return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "•".repeat(token.length);
  const head = token.slice(0, idx);
  const tail = token.slice(idx + 1);
  const tailMasked = tail.length > 6 ? `${tail.slice(0, 3)}${"•".repeat(Math.max(4, tail.length - 6))}${tail.slice(-3)}` : "•".repeat(tail.length);
  return `${head}:${tailMasked}`;
}

function looksLikeToken(s: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(s.trim());
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
    const tg: TelegramChannelConfig = (raw.channels?.telegram as TelegramChannelConfig | undefined) || {};
    const accountsRaw = tg.accounts || {};

    type AccountOut = {
      id: string;
      hasToken: boolean;
      tokenMasked: string;
      token: string | null;
      chatId: string | null;
      dmPolicy: DmPolicy | null;
      diagnostics: null | {
        bot: Awaited<ReturnType<typeof tgCall>> & { result?: { id: number; is_bot: boolean; first_name: string; username?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean; supports_inline_queries?: boolean } };
        webhook: Awaited<ReturnType<typeof tgCall>> & { result?: { url: string; has_custom_certificate: boolean; pending_update_count: number; ip_address?: string; last_error_date?: number; last_error_message?: string; last_synchronization_error_date?: number; max_connections?: number; allowed_updates?: string[] } };
        updates: { ok: boolean; count: number; latestText?: string; latestFrom?: string; latestDate?: number; error?: string };
      };
    };

    const accounts: AccountOut[] = [];

    for (const [id, acct] of Object.entries(accountsRaw)) {
      const token = typeof acct.botToken === "string" ? acct.botToken.trim() : "";
      const hasToken = !!token && token !== "configured_mock_token";

      let diagnostics: AccountOut["diagnostics"] = null;
      if (includeLive && hasToken) {
        const [bot, webhook, updatesRaw] = await Promise.all([
          tgCall<{ id: number; is_bot: boolean; first_name: string; username?: string }>(token, "getMe"),
          tgCall<{ url: string; has_custom_certificate: boolean; pending_update_count: number; last_error_date?: number; last_error_message?: string; max_connections?: number; allowed_updates?: string[] }>(token, "getWebhookInfo"),
          tgCall<Array<{ update_id: number; message?: { date: number; text?: string; from?: { id: number; first_name?: string; username?: string } } }>>(token, "getUpdates", { limit: 5, timeout: 0 }),
        ]);

        let updates: NonNullable<AccountOut["diagnostics"]>["updates"];
        if (!updatesRaw.ok) {
          // Common case: 409 Conflict — webhook is set, getUpdates is rejected
          updates = {
            ok: false,
            count: 0,
            error: updatesRaw.description || updatesRaw.networkError || `HTTP ${updatesRaw.httpStatus ?? "?"}`,
          };
        } else {
          const arr = updatesRaw.result || [];
          const latest = arr[arr.length - 1];
          updates = {
            ok: true,
            count: arr.length,
            latestText: latest?.message?.text,
            latestFrom: latest?.message?.from?.username || latest?.message?.from?.first_name,
            latestDate: latest?.message?.date,
          };
        }

        diagnostics = { bot, webhook, updates };
      }

      accounts.push({
        id,
        hasToken,
        tokenMasked: hasToken ? maskToken(token) : "",
        token: hasToken && revealToken ? token : null,
        chatId: typeof acct.chatId === "string" && acct.chatId.trim() ? acct.chatId.trim() : null,
        dmPolicy: (acct.dmPolicy as DmPolicy) ?? null,
        diagnostics,
      });
    }

    // Recent activity (telegram-tagged) — best effort
    let recentActivity: Array<{ timestamp: string; status: string; description: string }> = [];
    try {
      const acts = getActivities({ search: "Telegram", limit: 10, sort: "newest" });
      recentActivity = acts.activities.map((a) => ({
        timestamp: a.timestamp,
        status: a.status,
        description: a.description,
      }));
    } catch {}

    // Aggregate health
    const issues: string[] = [];
    if (!tg.enabled) issues.push("channels.telegram.enabled = false (canal desabilitado)");
    if (accounts.length === 0) issues.push("Nenhum bot/conta configurada em channels.telegram.accounts");
    for (const a of accounts) {
      if (!a.hasToken) issues.push(`Conta "${a.id}": botToken ausente ou placeholder`);
      if (a.diagnostics?.bot && !a.diagnostics.bot.ok) {
        issues.push(`Conta "${a.id}": getMe falhou — ${a.diagnostics.bot.description || a.diagnostics.bot.networkError || "?"}`);
      }
      const wh = a.diagnostics?.webhook?.result;
      if (wh?.url && wh.url.length > 0) {
        issues.push(`Conta "${a.id}": webhook ativo (${wh.url}) — polling não receberá mensagens. Use "Limpar webhook" se não usa webhook.`);
      }
      if (wh?.last_error_message) {
        issues.push(`Conta "${a.id}": último erro do webhook — ${wh.last_error_message}`);
      }
      if (wh && wh.pending_update_count > 50) {
        issues.push(`Conta "${a.id}": ${wh.pending_update_count} updates pendentes (backlog grande)`);
      }
      if (a.diagnostics?.updates && !a.diagnostics.updates.ok && !wh?.url) {
        issues.push(`Conta "${a.id}": getUpdates falhou — ${a.diagnostics.updates.error}`);
      }
      if (!a.chatId) issues.push(`Conta "${a.id}": chatId não definido — alertas (cost/budget) não conseguirão enviar mensagens proativas`);
    }

    const healthy = issues.length === 0 && accounts.length > 0;

    return NextResponse.json({
      config: {
        path: configPath,
        isFallback,
        enabled: !!tg.enabled,
        dmPolicy: tg.dmPolicy ?? "pairing",
      },
      accounts,
      recentActivity,
      summary: { healthy, issues },
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
// Body:
//   {
//     enabled?: boolean,
//     dmPolicy?: string,
//     accounts?: { [id]: { botToken?: string, chatId?: string, dmPolicy?: string } },
//     deleteAccountIds?: string[]
//   }
// Token rules: pass empty string to clear; omit to keep existing.

export async function PUT(req: NextRequest) {
  let body: {
    enabled?: boolean;
    dmPolicy?: DmPolicy;
    accounts?: Record<string, { botToken?: string; chatId?: string; dmPolicy?: DmPolicy }>;
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
    const tg = ((raw.channels.telegram as TelegramChannelConfig | undefined) ||
      ({ dmPolicy: "pairing", accounts: {} } as TelegramChannelConfig));
    if (!tg.accounts) tg.accounts = {};

    if (typeof body.enabled === "boolean") tg.enabled = body.enabled;
    if (typeof body.dmPolicy === "string" && body.dmPolicy) tg.dmPolicy = body.dmPolicy;

    if (body.accounts) {
      for (const [id, patch] of Object.entries(body.accounts)) {
        const cleanId = id.trim();
        if (!cleanId) continue;
        const cur = (tg.accounts[cleanId] || {}) as TelegramAccountConfig;
        if (typeof patch.botToken === "string") {
          const t = patch.botToken.trim();
          if (t.length > 0 && !looksLikeToken(t)) {
            return NextResponse.json(
              { error: `botToken de "${cleanId}" não parece um token Telegram válido (formato esperado: 123456:ABC-DEF...)` },
              { status: 400 },
            );
          }
          cur.botToken = t;
        }
        if (typeof patch.chatId === "string") {
          cur.chatId = patch.chatId.trim();
        }
        if (typeof patch.dmPolicy === "string" && patch.dmPolicy) {
          cur.dmPolicy = patch.dmPolicy;
        }
        tg.accounts[cleanId] = cur;
      }
    }

    if (body.deleteAccountIds && Array.isArray(body.deleteAccountIds)) {
      for (const id of body.deleteAccountIds) {
        if (typeof id === "string" && tg.accounts[id]) delete tg.accounts[id];
      }
    }

    raw.channels.telegram = tg;
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

  let body: { accountId?: string; chatId?: string; message?: string; token?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK for some actions
  }

  const accountId = (body.accountId || "main").trim();

  try {
    const { raw } = readConfig();
    const acct = (raw.channels?.telegram as TelegramChannelConfig | undefined)?.accounts?.[accountId];
    // Prefer the explicit token from the request body so the user can test a
    // freshly-pasted token BEFORE saving — previously the modal forced a save
    // first, which was confusing because the input already showed the token.
    const bodyToken = typeof body.token === "string" ? body.token.trim() : "";
    const savedToken = typeof acct?.botToken === "string" ? acct.botToken.trim() : "";
    const token = bodyToken || savedToken;
    if (!token || token === "configured_mock_token") {
      return NextResponse.json(
        { error: `Conta "${accountId}" sem botToken (nem salvo no JSON, nem enviado no teste)` },
        { status: 400 },
      );
    }
    if (bodyToken && !looksLikeToken(bodyToken)) {
      return NextResponse.json(
        { error: `Token enviado não parece um token Telegram válido (formato esperado: 123456:ABC-DEF...)` },
        { status: 400 },
      );
    }

    if (action === "test") {
      const chatId = (body.chatId || acct?.chatId || "").trim();
      if (!chatId) {
        return NextResponse.json(
          { error: `chatId não fornecido nem persistido para "${accountId}"` },
          { status: 400 },
        );
      }
      const message =
        body.message ||
        `<b>✅ Teste do AtlasDeck</b>\nSe você está lendo isto, a conexão Telegram da conta <code>${accountId}</code> está funcionando.\n\n<i>${new Date().toLocaleString("pt-BR")}</i>`;
      const r = await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      });
      if (!r.ok) {
        return NextResponse.json({
          success: false,
          error: r.description || r.networkError || `HTTP ${r.httpStatus ?? "?"}`,
          errorCode: r.errorCode,
        });
      }
      return NextResponse.json({ success: true, sentTo: chatId });
    }

    if (action === "clear-webhook") {
      const r = await tgCall(token, "deleteWebhook", { drop_pending_updates: false });
      if (!r.ok) {
        return NextResponse.json({
          success: false,
          error: r.description || r.networkError || `HTTP ${r.httpStatus ?? "?"}`,
        });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json(
      { error: `Ação desconhecida: "${action}". Use ?action=test ou ?action=clear-webhook` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
