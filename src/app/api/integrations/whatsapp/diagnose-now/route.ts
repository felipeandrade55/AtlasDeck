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
      allowFrom: wa.allowFrom,
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

// Parse the ISO timestamp embedded in an openclaw log line. The journalctl
// header looks like "May 30 01:32:08 host node[pid]: 2026-05-30T01:32:08…"
// — we grab the second timestamp (the openclaw one) because it carries
// timezone info and we don't have to guess the year.
function lineTimestampMs(line: string): number | null {
  const m = line.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\b/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

interface LogStats {
  inboundCount: number;
  dispatchCount: number;
  lastInboundLine: string | null;
  lastDispatchLine: string | null;
}

function statsForLines(lines: string[]): LogStats {
  let inbound = 0;
  let dispatch = 0;
  let lastInbound: string | null = null;
  let lastDispatch: string | null = null;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const looksWhatsapp =
      lower.includes("[whatsapp]") || lower.includes("baileys") || lower.includes("channel=whatsapp");
    if (!looksWhatsapp) continue;
    // OpenClaw logs inbound either as "Inbound message" (telegram pattern,
    // and same exists for whatsapp) or as the bare "[whatsapp] … from".
    if (/inbound message/i.test(line) || /\[whatsapp\][^\n]*\bfrom\b/.test(line)) {
      inbound += 1;
      lastInbound = line;
    }
    // OpenClaw routes the inbound to the agent via the gateway WS layer,
    // logged as "[ws] ⇄ res ✓ message.action … channel=whatsapp …". That's
    // the actual dispatch signal — NOT a string called "dispatch".
    if (
      /message\.action[^\n]*channel=whatsapp/i.test(line) ||
      /agent[^\n]*whatsapp/i.test(line)
    ) {
      dispatch += 1;
      lastDispatch = line;
    }
  }
  return { inboundCount: inbound, dispatchCount: dispatch, lastInboundLine: lastInbound, lastDispatchLine: lastDispatch };
}

function analyzeLogs(text: string): {
  recent: LogStats;
  total: LogStats;
  sessionDropCount: number;
  lastListeningAtMs: number | null;
  lastErrorLine: string | null;
  baileysReconnects: number;
  recentWindowMinutes: number;
} {
  const recentWindowMinutes = 5;
  const cutoffMs = Date.now() - recentWindowMinutes * 60_000;

  const allLines = text.split("\n");
  const recentLines: string[] = [];
  let sessionDrops = 0;
  let baileysReconnects = 0;
  let lastListeningAtMs: number | null = null;
  let lastError: string | null = null;

  for (const line of allLines) {
    const ts = lineTimestampMs(line);
    if (ts !== null && ts >= cutoffMs) recentLines.push(line);

    const lower = line.toLowerCase();
    if (lower.includes("whatsapp") || lower.includes("baileys")) {
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
      if (lower.includes("listening for personal whatsapp") && ts !== null) {
        lastListeningAtMs = ts;
      }
      if (lower.includes("error") || lower.includes(" err ")) {
        lastError = line;
      }
    }
  }

  return {
    recent: statsForLines(recentLines),
    total: statsForLines(allLines),
    sessionDropCount: sessionDrops,
    lastListeningAtMs,
    lastErrorLine: lastError,
    baileysReconnects,
    recentWindowMinutes,
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
    } else if (cfg.dmPolicy === "open") {
      const allowFrom = Array.isArray(cfg.allowFrom) ? (cfg.allowFrom as string[]) : [];
      if (allowFrom.length === 0) {
        findings.push({
          severity: "fail",
          area: "config",
          message:
            'dmPolicy="open" MAS channels.whatsapp.allowFrom está vazio — o plugin do WhatsApp filtra TODOS os DMs nessa combinação. Inbound chega mas nada vai pro agente.',
          detail:
            "Salve o modo de novo (Owner/Assistant/Open) ou clique Reparar config — a versão atual da operationModeToChannelConfig adiciona allowFrom=['*'] automaticamente.",
        });
      } else if (allowFrom.includes("*")) {
        findings.push({
          severity: "ok",
          area: "config",
          message: `dmPolicy="open" + allowFrom=["*"] — qualquer pessoa pode mandar DM pro bot.`,
        });
      } else {
        findings.push({
          severity: "warn",
          area: "config",
          message: `dmPolicy="open" + allowFrom restrito a ${allowFrom.length} número(s). Apenas esses passam: ${allowFrom.slice(0, 5).join(", ")}${allowFrom.length > 5 ? "…" : ""}`,
        });
      }
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
          message: `${sig.sessionDropCount} desconexão(ões) do Baileys no histórico de logs (timeout/reconexão). ${sig.baileysReconnects} retry(s) detectado(s). Se você mandou 'oi' DURANTE uma reconexão, a mensagem foi perdida — tente de novo.`,
        });
      }

      // RECENT WINDOW — what matters for "manda oi agora e vê se funciona".
      // Counts only events in the last 5 minutes so a fresh test isn't
      // drowned by stale numbers from older broken configs.
      if (sig.recent.inboundCount === 0) {
        findings.push({
          severity: "warn",
          area: "baileys",
          message: `Nenhuma mensagem WhatsApp inbound nos últimos ${sig.recentWindowMinutes}min. Histórico total: ${sig.total.inboundCount} inbound. Manda 'oi' agora e roda este diagnóstico de novo — se o contador subir, Baileys tá entregando. Se não subir, a mensagem não chegou (remetente bloqueado / primeiro contato bloqueado / sessão desconectada).`,
        });
      } else {
        const dispatchOk = sig.recent.dispatchCount > 0;
        findings.push({
          severity: dispatchOk ? "ok" : "fail",
          area: dispatchOk ? "agent" : "agent",
          message: dispatchOk
            ? `Janela ${sig.recentWindowMinutes}min: ${sig.recent.inboundCount} inbound → ${sig.recent.dispatchCount} chegaram no agente. ✓ Pipeline ok.`
            : `Janela ${sig.recentWindowMinutes}min: ${sig.recent.inboundCount} inbound, ZERO chegaram no agente. Filtro do plugin tá bloqueando (allowFrom / groupPolicy / requireMention).`,
          detail: (dispatchOk ? sig.recent.lastDispatchLine : sig.recent.lastInboundLine) ?? undefined,
        });
      }

      // Historical context (informational, not a verdict on right-now).
      if (sig.total.inboundCount > 0) {
        findings.push({
          severity: "info",
          area: "baileys",
          message: `Histórico total nos logs: ${sig.total.inboundCount} inbound, ${sig.total.dispatchCount} dispatched. Contagens incluem mensagens antigas (de antes de fixes de config).`,
          detail: sig.total.lastInboundLine ?? undefined,
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
