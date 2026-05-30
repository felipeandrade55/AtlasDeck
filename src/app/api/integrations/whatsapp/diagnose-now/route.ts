/**
 * POST /api/integrations/whatsapp/diagnose-now
 *
 * One-shot "por que o bot não tá respondendo?" diagnostic for the
 * WhatsApp channel. Reads the gateway log tail + current openclaw.json
 * channel snapshot + briefing log (recent entries = bot DID process) and
 * returns a plain-Portuguese verdict the user can act on without
 * touching SSH.
 *
 * Designed for the "mandei oi e nada aconteceu" scenario:
 *   - Verifica se a config WhatsApp tá realmente aplicada (mode, dmPolicy,
 *     messagePrefix, sendReadReceipts, etc).
 *   - Verifica gateway.reload.mode (precisa ser "hybrid" pra hot-reload).
 *   - Le os últimos 200 lines do journalctl, filtra por whatsapp/inbound/
 *     dispatch/baileys/error, extrai sinais (sessão caiu? inbound chegou?
 *     dispatch saiu? agent rodou?).
 *   - Olha a briefing-db: se tem entries recentes, o bot atendeu — o
 *     problema é outro. Se NÃO tem, o agent não foi chamado.
 *   - Retorna findings[] com severity + recommendation textual.
 */
import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { gatewayLogs } from "@/lib/gateway-control";
import { listBriefings, summarizeBriefings } from "@/lib/whatsapp-briefing-db";

export const dynamic = "force-dynamic";

interface Finding {
  severity: "ok" | "info" | "warn" | "fail";
  area: "config" | "gateway" | "baileys" | "agent" | "briefing";
  message: string;
  detail?: string;
}

function readWhatsappConfig(): Record<string, unknown> {
  const { path } = resolveOpenClawAgentsConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const channels = (raw.channels && typeof raw.channels === "object" ? raw.channels : {}) as Record<
      string,
      unknown
    >;
    const wa = (channels.whatsapp && typeof channels.whatsapp === "object" ? channels.whatsapp : {}) as Record<
      string,
      unknown
    >;
    const gateway = (raw.gateway && typeof raw.gateway === "object" ? raw.gateway : {}) as Record<
      string,
      unknown
    >;
    const reload = (gateway.reload && typeof gateway.reload === "object" ? gateway.reload : {}) as Record<
      string,
      unknown
    >;
    return {
      enabled: wa.enabled,
      dmPolicy: wa.dmPolicy,
      groupPolicy: wa.groupPolicy,
      groupAllowFrom: wa.groupAllowFrom,
      selfChatMode: wa.selfChatMode,
      sendReadReceipts: wa.sendReadReceipts,
      reactionLevel: wa.reactionLevel,
      replyToMode: wa.replyToMode,
      messagePrefixPreview: typeof wa.messagePrefix === "string" ? wa.messagePrefix.slice(0, 100) : null,
      hasMessagePrefix: typeof wa.messagePrefix === "string" && wa.messagePrefix.length > 0,
      accounts: typeof wa.accounts === "object" ? Object.keys(wa.accounts as Record<string, unknown>) : [],
      reloadMode: reload.mode,
    };
  } catch {
    return {};
  }
}

function analyzeLogs(text: string): {
  inboundCount: number;
  dispatchCount: number;
  sessionDropCount: number;
  lastListeningAtMs: number | null;
  lastInboundLine: string | null;
  lastErrorLine: string | null;
  baileysReconnects: number;
} {
  const lines = text.split("\n");
  let inbound = 0;
  let dispatch = 0;
  let sessionDrops = 0;
  let baileysReconnects = 0;
  let lastListeningAtMs: number | null = null;
  let lastInbound: string | null = null;
  let lastError: string | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.includes("whatsapp") && !lower.includes("baileys")) continue;

    if (lower.includes("inbound") || /\[whatsapp\][^\n]*from/.test(line)) {
      inbound += 1;
      lastInbound = line;
    }
    if (lower.includes("dispatch") || lower.includes("agent:main:whatsapp")) {
      dispatch += 1;
    }
    if (
      lower.includes("connection closed") ||
      lower.includes("connection lost") ||
      lower.includes("status 408") ||
      lower.includes("status 503")
    ) {
      sessionDrops += 1;
    }
    if (/retry \d+\/\d+/.test(lower)) {
      baileysReconnects += 1;
    }
    if (lower.includes("listening for personal whatsapp")) {
      // Parse the iso-ish timestamp at the start of the journalctl line if possible.
      const m = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (m) {
        const t = Date.parse(m[1]);
        if (!Number.isNaN(t)) lastListeningAtMs = t;
      }
    }
    if (lower.includes("error") || lower.includes(" err ")) {
      lastError = line;
    }
  }

  return {
    inboundCount: inbound,
    dispatchCount: dispatch,
    sessionDropCount: sessionDrops,
    lastListeningAtMs,
    lastInboundLine: lastInbound,
    lastErrorLine: lastError,
    baileysReconnects,
  };
}

export async function POST() {
  try {
    const findings: Finding[] = [];

    // 1. CONFIG snapshot
    const cfg = readWhatsappConfig();
    if (cfg.enabled !== true) {
      findings.push({
        severity: "fail",
        area: "config",
        message:
          "Canal WhatsApp DESABILITADO em channels.whatsapp.enabled — gateway nem tenta ouvir.",
        detail: "Marque 'Canal habilitado' no modal WhatsApp e salve.",
      });
    } else {
      findings.push({ severity: "ok", area: "config", message: "Canal WhatsApp habilitado." });
    }

    if (cfg.dmPolicy === "disabled" || !cfg.dmPolicy) {
      findings.push({
        severity: "fail",
        area: "config",
        message: `dmPolicy="${cfg.dmPolicy ?? "(não definido)"}" — gateway descarta TODA DM antes de chegar no agente.`,
        detail:
          "Você provavelmente está no modo Passivo. Mude pro modo Owner/Assistant/Open no dropdown e salve.",
      });
    } else {
      findings.push({
        severity: "ok",
        area: "config",
        message: `dmPolicy="${cfg.dmPolicy}" — DMs vão pro agente.`,
      });
    }

    if (!cfg.hasMessagePrefix && cfg.dmPolicy !== "disabled") {
      findings.push({
        severity: "warn",
        area: "config",
        message:
          "Sem messagePrefix — agente não recebe persona/regras de grupo. Não bloqueia, mas o bot responde sem o roteiro do modo escolhido.",
      });
    }

    if (cfg.reloadMode !== "hybrid") {
      findings.push({
        severity: "warn",
        area: "gateway",
        message: `gateway.reload.mode="${cfg.reloadMode ?? "(não definido)"}" — hot-reload pode não estar ativo. Clique Reparar config pra forçar "hybrid".`,
      });
    }

    // 2. GATEWAY LOG tail
    const logsRes = await gatewayLogs({ lines: 300 }).catch(() => null);
    if (!logsRes?.found) {
      findings.push({
        severity: "fail",
        area: "gateway",
        message:
          "Não consegui ler os logs do gateway (journalctl/PM2). Verifique se openclaw-gateway está rodando.",
      });
    } else {
      const sig = analyzeLogs(logsRes.output);

      if (sig.lastListeningAtMs) {
        const ageMin = Math.round((Date.now() - sig.lastListeningAtMs) / 60_000);
        findings.push({
          severity: "ok",
          area: "baileys",
          message: `Última vez que a sessão WhatsApp inicializou: ${ageMin}min atrás.`,
        });
      } else {
        findings.push({
          severity: "warn",
          area: "baileys",
          message:
            "Não vi nenhuma linha '[whatsapp] Listening for personal WhatsApp inbound messages' nos últimos 300 lines — a sessão Baileys pode não ter inicializado, OU o log já scrollou pra fora.",
        });
      }

      if (sig.sessionDropCount > 0) {
        findings.push({
          severity: "warn",
          area: "baileys",
          message: `${sig.sessionDropCount} desconexão(ões) do Baileys nos últimos logs (timeout/reconexão). ${sig.baileysReconnects} retry(s) detectado(s). Se você mandou 'oi' durante uma reconexão, a mensagem foi perdida — tente de novo.`,
        });
      }

      if (sig.inboundCount === 0) {
        findings.push({
          severity: "fail",
          area: "baileys",
          message:
            "ZERO mensagens WhatsApp inbound nos logs do gateway. O 'oi' do outro número NÃO está chegando — possíveis causas:\n" +
            "• O remetente está bloqueado no seu WhatsApp\n" +
            "• A sessão Baileys está desconectada (verifique no card 'Status: connected' do modal)\n" +
            "• O número que mandou não tem conversa anterior com você (WhatsApp Web às vezes filtra primeiro contato)\n" +
            "• A mensagem caiu durante uma reconexão (manda de novo agora)",
        });
      } else {
        findings.push({
          severity: "ok",
          area: "baileys",
          message: `${sig.inboundCount} mensagens WhatsApp inbound detectadas nos logs.`,
          detail: sig.lastInboundLine ?? undefined,
        });
      }

      if (sig.inboundCount > 0 && sig.dispatchCount === 0) {
        findings.push({
          severity: "fail",
          area: "agent",
          message:
            "Mensagens chegaram no gateway mas NÃO foram roteadas pro agente (zero linhas 'dispatch' / 'agent:main:whatsapp'). Provavelmente filtro dmPolicy/groupPolicy bloqueou, ou a allowFrom restringiu.",
        });
      }

      if (sig.lastErrorLine) {
        findings.push({
          severity: "warn",
          area: "gateway",
          message: "Erro recente nos logs:",
          detail: sig.lastErrorLine,
        });
      }
    }

    // 3. BRIEFING — bot did process if entries exist
    const briefSummary = summarizeBriefings();
    const recentBrief = listBriefings({
      sinceMs: Date.now() - 60 * 60 * 1000,
      limit: 5,
    });
    if (recentBrief.length > 0) {
      findings.push({
        severity: "ok",
        area: "briefing",
        message: `O bot já processou ${recentBrief.length} conversa(s) na última hora no modo Assessor — funcionando.`,
      });
    } else if (briefSummary.totalPending === 0) {
      findings.push({
        severity: "info",
        area: "briefing",
        message:
          "Nenhuma entrada no briefing do Assessor (nem recente, nem pendente). Esperado se você está em outro modo, ou se o bot ainda não atendeu ninguém.",
      });
    }

    // Verdict / next step
    const fails = findings.filter((f) => f.severity === "fail");
    const warns = findings.filter((f) => f.severity === "warn");
    let verdict: string;
    if (fails.length > 0) {
      verdict = `Encontrei ${fails.length} problema(s) crítico(s). Corrige o primeiro 'fail' acima e tenta de novo.`;
    } else if (warns.length > 0) {
      verdict = `Sem erro crítico — ${warns.length} alerta(s) pra investigar. Se o bot ainda não responde, manda outro 'oi' agora e roda este diagnóstico novamente.`;
    } else {
      verdict = "Tudo verde. Manda 'oi' de outro número agora e roda novamente em 10s pra ver se chegou.";
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      config: cfg,
      verdict,
      findings,
      logsSource: logsRes?.source ?? null,
      logsTail: logsRes?.found
        ? logsRes.output.split("\n").slice(-30).join("\n")
        : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
