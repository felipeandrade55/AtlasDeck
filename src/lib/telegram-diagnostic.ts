/**
 * Unified Telegram + OpenClaw health diagnostic. Used by:
 *   - GET/POST /api/integrations/telegram/diagnose (user-facing doctor)
 *   - lib/health-monitor (background watcher that notifies the bell)
 *
 * Pure logic, no Next.js types — safe to call from a server-side scheduler.
 */
import { readFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "./openclaw-config";
import { getTelegramAccountLocal } from "./telegram-accounts-local";
import { tgCall, type TgBotInfo, type TgWebhookInfo } from "./telegram-api";
import { detectGatewayRuntime } from "./gateway-control";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface FixHint {
  action:
    | "clear-webhook"
    | "drop-pending"
    | "restart-gateway"
    | "open-setup"
    | "runbook"
    | "retry";
  label: string;
  accountId?: string;
  destructive?: boolean;
  runbook?: string[];
}

export interface DiagnosticCheck {
  id: string;
  category: "telegram" | "openclaw" | "config";
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: FixHint;
}

export interface DiagnoseResponse {
  ok: boolean;
  timestamp: string;
  checks: DiagnosticCheck[];
  testMessage: {
    attempted: boolean;
    sent: boolean;
    accountId?: string;
    sentTo?: string;
    error?: string;
  };
  summary: {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
    headline: string;
  };
}

interface OpenClawJson {
  channels?: {
    telegram?: {
      enabled?: boolean;
      accounts?: Record<string, { botToken?: string; chatId?: string }>;
    };
  };
}

function readChannelConfig(): OpenClawJson {
  const { path: configPath } = resolveOpenClawAgentsConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export interface RunDiagnoseOptions {
  sendTest: boolean;
  testMessage?: string;
  testAccountId?: string;
}

export async function runDiagnose(opts: RunDiagnoseOptions): Promise<DiagnoseResponse> {
  const checks: DiagnosticCheck[] = [];
  const cfg = readChannelConfig();
  const tg = cfg.channels?.telegram;
  const accountsRaw = tg?.accounts ?? {};
  const accountIds = Object.keys(accountsRaw);

  checks.push({
    id: "channel-enabled",
    category: "config",
    label: "Canal Telegram habilitado",
    status: tg?.enabled ? "pass" : "warn",
    detail: tg?.enabled
      ? "channels.telegram.enabled = true"
      : "channels.telegram.enabled = false — alertas e DMs não saem.",
    fix: tg?.enabled
      ? undefined
      : { action: "open-setup", label: "Abrir setup do Telegram" },
  });

  if (accountIds.length === 0) {
    checks.push({
      id: "no-accounts",
      category: "config",
      label: "Contas de bot",
      status: "fail",
      detail: "Nenhuma conta configurada em channels.telegram.accounts.",
      fix: { action: "open-setup", label: "Configurar bot" },
    });
  }

  const testAccountTarget =
    opts.testAccountId ||
    accountIds.find((id) => {
      const t = accountsRaw[id]?.botToken?.trim();
      return t && t !== "configured_mock_token";
    }) ||
    null;

  const testMessage: DiagnoseResponse["testMessage"] = {
    attempted: false,
    sent: false,
  };

  for (const id of accountIds) {
    const acct = accountsRaw[id] || {};
    const token = (acct.botToken ?? "").trim();
    const hasToken = token.length > 0 && token !== "configured_mock_token";
    const localChatId = getTelegramAccountLocal(id).chatId;
    const legacyChatId = (acct.chatId ?? "").trim();
    const chatId = localChatId || legacyChatId || "";

    if (!hasToken) {
      checks.push({
        id: `token-${id}`,
        category: "config",
        label: `Conta "${id}": bot token`,
        status: "fail",
        detail: "botToken ausente ou placeholder.",
        fix: { action: "open-setup", label: "Inserir token", accountId: id },
      });
      continue;
    }

    const [bot, webhook, updates] = await Promise.all([
      tgCall<TgBotInfo>(token, "getMe"),
      tgCall<TgWebhookInfo>(token, "getWebhookInfo"),
      tgCall(token, "getUpdates", { limit: 1, timeout: 0 }),
    ]);

    checks.push({
      id: `bot-${id}`,
      category: "telegram",
      label: `Conta "${id}": bot válido`,
      status: bot.ok ? "pass" : "fail",
      detail: bot.ok
        ? `@${bot.result?.username ?? "?"} (id ${bot.result?.id})`
        : `getMe falhou: ${bot.description || bot.networkError || `HTTP ${bot.httpStatus ?? "?"}`}`,
      fix: bot.ok
        ? undefined
        : { action: "open-setup", label: "Revisar token", accountId: id },
    });

    checks.push({
      id: `chatid-${id}`,
      category: "config",
      label: `Conta "${id}": chatId definido`,
      status: chatId ? "pass" : "warn",
      detail: chatId
        ? `Envio proativo direcionado a ${chatId}`
        : "Sem chatId — alertas (custo, briefing matinal) não conseguem destinatário.",
      fix: chatId
        ? undefined
        : { action: "open-setup", label: "Definir chatId", accountId: id },
    });

    const wh = webhook.result;
    if (wh?.url) {
      checks.push({
        id: `webhook-${id}`,
        category: "telegram",
        label: `Conta "${id}": webhook ativo`,
        status: "fail",
        detail: `Webhook está em ${wh.url} — getUpdates fica bloqueado e o OpenClaw (que usa polling) não vê mensagens.`,
        fix: { action: "clear-webhook", label: "Limpar webhook", accountId: id },
      });
    } else {
      checks.push({
        id: `webhook-${id}`,
        category: "telegram",
        label: `Conta "${id}": webhook limpo`,
        status: "pass",
        detail: "Polling livre — getUpdates pode rodar normalmente.",
      });
    }

    if (wh?.last_error_message) {
      const when = wh.last_error_date
        ? new Date(wh.last_error_date * 1000).toLocaleString("pt-BR")
        : "?";
      checks.push({
        id: `webhook-error-${id}`,
        category: "telegram",
        label: `Conta "${id}": erro no webhook`,
        status: "warn",
        detail: `${wh.last_error_message} (em ${when}). Provavelmente histórico — só importa se o webhook ainda estiver setado.`,
      });
    }

    const pending = wh?.pending_update_count ?? 0;
    if (pending > 50) {
      checks.push({
        id: `backlog-${id}`,
        category: "telegram",
        label: `Conta "${id}": backlog de updates`,
        status: "warn",
        detail: `${pending} updates pendentes — o OpenClaw vai processar com atraso.`,
        fix: {
          action: "drop-pending",
          label: `Descartar ${pending} pendentes`,
          accountId: id,
          destructive: true,
        },
      });
    }

    if (!wh?.url && !updates.ok) {
      checks.push({
        id: `polling-${id}`,
        category: "telegram",
        label: `Conta "${id}": getUpdates`,
        status: "warn",
        detail: `getUpdates falhou: ${updates.description || updates.networkError || `HTTP ${updates.httpStatus ?? "?"}`}.`,
      });
    }

    if (opts.sendTest && id === testAccountTarget) {
      testMessage.attempted = true;
      testMessage.accountId = id;
      if (!chatId) {
        testMessage.error = `Conta "${id}" sem chatId — não dá pra mandar teste.`;
      } else {
        const text =
          opts.testMessage ||
          `<b>🩺 Diagnóstico AtlasDeck</b>\nSe você recebeu esta mensagem, a integração Telegram da conta <code>${id}</code> está saudável.\n\n<i>${new Date().toLocaleString("pt-BR")}</i>`;
        const r = await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        });
        if (r.ok) {
          testMessage.sent = true;
          testMessage.sentTo = chatId;
          checks.push({
            id: `test-${id}`,
            category: "telegram",
            label: `Conta "${id}": mensagem de teste`,
            status: "pass",
            detail: `Entregue ao chat ${chatId}. Se você não viu chegar, é provavelmente o cliente Telegram (notificações silenciadas / bot bloqueado).`,
          });
        } else {
          testMessage.error =
            r.description || r.networkError || `HTTP ${r.httpStatus ?? "?"}`;
          checks.push({
            id: `test-${id}`,
            category: "telegram",
            label: `Conta "${id}": mensagem de teste`,
            status: "fail",
            detail: `Falha ao enviar: ${testMessage.error}`,
            fix: { action: "retry", label: "Tentar de novo", accountId: id },
          });
        }
      }
    }
  }

  try {
    const runtime = await detectGatewayRuntime();
    const isRunning = runtime !== "unknown";
    checks.push({
      id: "gateway",
      category: "openclaw",
      label: "Gateway OpenClaw",
      status: isRunning ? "pass" : "fail",
      detail: isRunning
        ? `Rodando via ${runtime}.`
        : "Nenhum processo do gateway encontrado — o bot do Telegram não vai responder mesmo com o token OK.",
      fix: isRunning
        ? { action: "restart-gateway", label: "Reiniciar gateway" }
        : {
            action: "restart-gateway",
            label: "Iniciar gateway",
            runbook: [
              "O AtlasDeck tenta restart adaptativo (systemd → PM2 → process)",
              "Se falhar, no servidor: `systemctl --user start openclaw` ou `pm2 start openclaw-gateway`",
            ],
          },
    });
  } catch (e) {
    checks.push({
      id: "gateway",
      category: "openclaw",
      label: "Gateway OpenClaw",
      status: "skip",
      detail: `Não consegui inspecionar o runtime: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status]++;

  let headline: string;
  if (counts.fail > 0) {
    headline = `${counts.fail} problema(s) crítico(s) detectado(s)`;
  } else if (counts.warn > 0) {
    headline = `${counts.warn} alerta(s) — vale revisar`;
  } else if (counts.skip > 0 && counts.pass === 0) {
    headline = "Nada verificado — confira a configuração";
  } else {
    headline = "Tudo saudável";
  }

  return {
    ok: counts.fail === 0,
    timestamp: new Date().toISOString(),
    checks,
    testMessage,
    summary: { ...counts, headline },
  };
}
