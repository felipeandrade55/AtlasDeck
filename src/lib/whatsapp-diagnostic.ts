/**
 * Unified WhatsApp + OpenClaw health diagnostic.
 * Modeled after telegram-diagnostic to provide identical levels of support.
 */
import { readFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "./openclaw-config";
import { getWhatsappAccountLocal } from "./whatsapp-accounts-local";
import { waCall, looksLikePhoneNumber, hasWhatsappSessionLocal } from "./whatsapp-api";
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
  category: "whatsapp" | "openclaw" | "config";
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
  routing: Array<{
    accountId: string;
    sessionStatus: string;
    webhookSet: boolean;
  }>;
}

interface OpenClawJson {
  channels?: {
    whatsapp?: {
      enabled?: boolean;
      accounts?: Record<string, { token?: string; phoneNumber?: string; chatId?: string }>;
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
  const wa = cfg.channels?.whatsapp;
  const accountsRaw = wa?.accounts ?? {};
  const accountIds = Object.keys(accountsRaw);

  checks.push({
    id: "channel-enabled",
    category: "config",
    label: "Canal WhatsApp habilitado",
    status: wa?.enabled ? "pass" : "warn",
    detail: wa?.enabled
      ? "channels.whatsapp.enabled = true"
      : "channels.whatsapp.enabled = false — alertas e DMs não saem.",
    fix: wa?.enabled
      ? undefined
      : { action: "open-setup", label: "Abrir setup do WhatsApp" },
  });

  if (accountIds.length === 0) {
    checks.push({
      id: "no-accounts",
      category: "config",
      label: "Contas de WhatsApp",
      status: "fail",
      detail: "Nenhuma conta configurada em channels.whatsapp.accounts.",
      fix: { action: "open-setup", label: "Configurar WhatsApp" },
    });
  }

  const testAccountTarget =
    opts.testAccountId ||
    accountIds.find((id) => {
      const t = accountsRaw[id]?.token?.trim();
      return t && t !== "configured_mock_token";
    }) ||
    null;

  const testMessage: DiagnoseResponse["testMessage"] = {
    attempted: false,
    sent: false,
  };

  const routing: DiagnoseResponse["routing"] = [];

  for (const id of accountIds) {
    const acct = accountsRaw[id] || {};
    const token = (acct.token ?? "").trim();
    const hasToken = token.length > 0 && token !== "configured_mock_token";
    const phoneNumber = (acct.phoneNumber ?? "").trim();
    const localChatId = getWhatsappAccountLocal(id).chatId;
    const legacyChatId = (acct.chatId ?? "").trim();
    const chatId = localChatId || legacyChatId || "";

    const localSessionExists = hasWhatsappSessionLocal(id);

    if (!hasToken) {
      if (localSessionExists) {
        checks.push({
          id: `token-${id}`,
          category: "config",
          label: `Conta "${id}": Método de conexão`,
          status: "pass",
          detail: "Conectado via WhatsApp Web (Baileys) local.",
        });
      } else {
        checks.push({
          id: `token-${id}`,
          category: "config",
          label: `Conta "${id}": token de acesso ou sessão`,
          status: "fail",
          detail: "Token de acesso ausente ou sessão WhatsApp Web não pareada.",
          fix: { action: "open-setup", label: "Parear WhatsApp Web ou Inserir token", accountId: id },
        });
        continue;
      }
    }

    if (!phoneNumber) {
      checks.push({
        id: `phone-${id}`,
        category: "config",
        label: `Conta "${id}": número de telefone`,
        status: "fail",
        detail: "phoneNumber não configurado para envio.",
        fix: { action: "open-setup", label: "Configurar telefone", accountId: id },
      });
      continue;
    }

    let isConnected = false;
    let diagnosticError = "";

    if (hasToken) {
      const diagnostic = await waCall<{ success: boolean; sessionStatus?: string }>(
        "https://api.meta.com/v16.0/me",
        "GET",
        token
      );
      isConnected = diagnostic.ok;
      diagnosticError = diagnostic.description || diagnostic.networkError || "Desconectado";
    } else {
      isConnected = localSessionExists;
      diagnosticError = "Sessão do WhatsApp Web não iniciada (QR Code não escaneado)";
    }

    checks.push({
      id: `session-${id}`,
      category: "whatsapp",
      label: `Conta "${id}": sessão ativa`,
      status: isConnected ? "pass" : "fail",
      detail: isConnected
        ? `Sessão conectada ${phoneNumber ? `no telefone ${phoneNumber}` : "via WhatsApp Web"}`
        : `Erro de conexão: ${diagnosticError}`,
      fix: isConnected
        ? undefined
        : { action: "open-setup", label: "Revisar credenciais ou parear WhatsApp Web", accountId: id },
    });

    checks.push({
      id: `chatid-${id}`,
      category: "config",
      label: `Conta "${id}": chatId (destinatário)`,
      status: chatId ? "pass" : "warn",
      detail: chatId
        ? `Envio de alertas direcionado a ${chatId}`
        : "Sem chatId — alertas de custos e briefing não têm destinatário configurado.",
      fix: chatId
        ? undefined
        : { action: "open-setup", label: "Definir chatId", accountId: id },
    });

    routing.push({
      accountId: id,
      sessionStatus: isConnected ? "connected" : "disconnected",
      webhookSet: false,
    });

    if (opts.sendTest && id === testAccountTarget) {
      testMessage.attempted = true;
      testMessage.accountId = id;
      if (!chatId) {
        testMessage.error = `Conta "${id}" sem chatId — não dá pra mandar teste.`;
      } else {
        const textMessage =
          opts.testMessage ||
          `*🩺 Diagnóstico WhatsApp AtlasDeck*\nSe você recebeu esta mensagem, a integração WhatsApp da conta *${id}* está saudável.\n\n_${new Date().toLocaleString("pt-BR")}_`;

        const r = await waCall(
          "https://api.meta.com/v16.0/messages",
          "POST",
          token,
          {
            messaging_product: "whatsapp",
            to: chatId,
            type: "text",
            text: { body: textMessage },
          }
        );

        if (r.ok) {
          testMessage.sent = true;
          testMessage.sentTo = chatId;
          checks.push({
            id: `test-${id}`,
            category: "whatsapp",
            label: `Conta "${id}": mensagem de teste`,
            status: "pass",
            detail: `Entregue ao número/grupo ${chatId}. Se não visualizar, verifique se o número de destino é válido e está no formato internacional (DDI+DDD+número).`,
          });
        } else {
          testMessage.error =
            r.description || r.networkError || `HTTP ${r.httpStatus ?? "?"}`;
          checks.push({
            id: `test-${id}`,
            category: "whatsapp",
            label: `Conta "${id}": mensagem de teste`,
            status: "fail",
            detail: `Falha ao enviar mensagem de teste: ${testMessage.error}`,
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
        : "Nenhum processo do gateway encontrado — o bot do WhatsApp não vai responder mesmo com o token OK.",
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
    routing,
  };
}
