/**
 * Unified WhatsApp + OpenClaw health diagnostic.
 * Modeled after telegram-diagnostic to provide identical levels of support.
 */
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { resolveOpenClawAgentsConfigPath, readOpenClawConfig } from "./openclaw-config";
import { getWhatsappAccountLocal } from "./whatsapp-accounts-local";
import { waCall, looksLikePhoneNumber, hasWhatsappSessionLocal } from "./whatsapp-api";
import { detectGatewayRuntime } from "./gateway-control";
import { WHATSAPP_PLUGIN, isPluginInstalled } from "./openclaw-plugins";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface FixHint {
  action:
    | "clear-webhook"
    | "drop-pending"
    | "restart-gateway"
    | "open-setup"
    | "runbook"
    | "retry"
    | "repair-config"
    | "install-whatsapp-plugin";
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
    accountIds[0] ||
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
    const local = getWhatsappAccountLocal(id);
    const phoneNumber = (local.phoneNumber || acct.phoneNumber || "").trim();
    const localChatId = local.chatId;
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
        if (!hasToken) {
          if (localSessionExists) {
            testMessage.sent = true;
            testMessage.sentTo = chatId;
            checks.push({
              id: `test-${id}`,
              category: "whatsapp",
              label: `Conta "${id}": teste (Sessão Local)`,
              status: "pass",
              detail: `Sessão local (WhatsApp Web) ativa! Como você está usando o WhatsApp Web (Baileys), envie uma mensagem de teste do seu celular diretamente para o bot para validar. Testes automáticos via painel exigem a API em Nuvem (Cloud API) com Token.`,
            });
          } else {
            testMessage.error = "Sessão do WhatsApp Web deslogada. Por favor, escaneie o QR Code primeiro.";
            checks.push({
              id: `test-${id}`,
              category: "whatsapp",
              label: `Conta "${id}": teste falhou`,
              status: "fail",
              detail: "Não foi possível testar: Sessão local do WhatsApp Web não está pareada/ativa e nenhum Token de Acesso em Nuvem foi configurado.",
            });
          }
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
              label: `Conta "${id}": mensagem de teste falhou`,
              status: "fail",
              detail: `Falha no envio da mensagem de teste: ${testMessage.error}`,
            });
          }
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

  // openclaw config validate — exposes the canonical schema errors (which
  // property is offending) that the gateway hides behind a truncated
  // "must NOT have additional properties" line. When validation fails the
  // gateway refuses to boot and `channels login` can't generate the QR.
  try {
    const { openclawBin, openclawDir } = readOpenClawConfig();
    const result = spawnSync(openclawBin, ["config", "validate"], {
      cwd: openclawDir,
      env: process.env,
      encoding: "utf-8",
      timeout: 8000,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();

    if (result.error) {
      checks.push({
        id: "openclaw-config",
        category: "openclaw",
        label: "Validação do openclaw.json",
        status: "skip",
        detail: `Não consegui rodar \`openclaw config validate\`: ${result.error.message}`,
      });
    } else if ((result.status ?? 1) === 0) {
      checks.push({
        id: "openclaw-config",
        category: "openclaw",
        label: "Validação do openclaw.json",
        status: "pass",
        detail: "Schema do OpenClaw aceito — gateway pode bootar e pareamento via QR consegue rodar.",
      });
    } else {
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
      const offending = lines.find((l) =>
        /channels\.whatsapp.*additional propert|additionalProperty|must NOT have additional/i.test(l),
      ) || lines.find((l) => /channels\.whatsapp/i.test(l));
      checks.push({
        id: "openclaw-config",
        category: "openclaw",
        label: "Validação do openclaw.json",
        status: "fail",
        detail:
          (offending
            ? `Validator do OpenClaw rejeita: ${offending}`
            : "Schema do OpenClaw rejeitou a config — pareamento via QR vai falhar até reparar.") +
          " Clique em Reparar pra mover campos AtlasDeck-only para o storage local e deixar accounts.<id> vazio.",
        fix: {
          action: "repair-config",
          label: "Reparar config OpenClaw",
          runbook: lines.slice(0, 10),
        },
      });
    }
  } catch (e) {
    checks.push({
      id: "openclaw-config",
      category: "openclaw",
      label: "Validação do openclaw.json",
      status: "skip",
      detail: `Não consegui validar o openclaw.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Channel plugin presence — `openclaw channels login --channel whatsapp`
  // silently exits when @openclaw/whatsapp isn't installed, which from the UI
  // looks indistinguishable from "the system can't generate the QR code".
  //
  // Use the filesystem probe (isPluginInstalled) instead of parsing the CLI
  // plugins-list output. The CLI format changes across openclaw versions and
  // we hit false-negatives (plugin clearly present on disk + pairing working,
  // but parser reported "not installed").
  try {
    const probe = isPluginInstalled(WHATSAPP_PLUGIN);
    if (probe.installed) {
      checks.push({
        id: "plugin-whatsapp",
        category: "openclaw",
        label: `Plugin ${WHATSAPP_PLUGIN}`,
        status: "pass",
        detail: "Plugin instalado no filesystem — `channels login --channel whatsapp` consegue rodar.",
      });
    } else if (probe.error) {
      checks.push({
        id: "plugin-whatsapp",
        category: "openclaw",
        label: `Plugin ${WHATSAPP_PLUGIN}`,
        status: "skip",
        detail: `Não consegui inspecionar a pasta de plugins do OpenClaw: ${probe.error}. Se o pareamento funcionou, ignore.`,
      });
    } else {
      checks.push({
        id: "plugin-whatsapp",
        category: "openclaw",
        label: `Plugin ${WHATSAPP_PLUGIN}`,
        status: "fail",
        detail:
          `Plugin ${WHATSAPP_PLUGIN} não está instalado em <openclawDir>/npm/node_modules/. ` +
          "A pré-flight do botão Parear instala automaticamente, mas dá pra adiantar clicando em Instalar agora.",
        fix: {
          action: "install-whatsapp-plugin",
          label: "Instalar plugin agora",
          runbook: [
            `Comando: ${readOpenClawConfig().openclawBin} plugins install ${WHATSAPP_PLUGIN}`,
            "Tamanho ~50 MB, pode demorar 30-90s na primeira vez.",
          ],
        },
      });
    }
  } catch (e) {
    checks.push({
      id: "plugin-whatsapp",
      category: "openclaw",
      label: `Plugin ${WHATSAPP_PLUGIN}`,
      status: "skip",
      detail: `Não consegui inspecionar plugins: ${e instanceof Error ? e.message : String(e)}`,
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
