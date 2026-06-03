/**
 * GET /api/integrations/whatsapp/briefing/diagnostics
 *
 * Returns the data the briefing page needs to render a smart empty-state
 * (vs the misleading "Sem recados pendentes. O assessor está em dia." which
 * is wrong when the bot simply isn't logging).
 *
 *   {
 *     mode: { operationMode, label, dmPolicy },
 *     activity: { last24hCount, lastTimestamp, lastDescription },
 *     briefings: { totalEver, lastTimestamp, pendingCount },
 *     hints: string[]   // human-readable diagnoses ordered by severity
 *   }
 */
import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import {
  getWhatsappAccountLocal,
  type WhatsappOperationMode,
} from "@/lib/whatsapp-accounts-local";
import { getActivities } from "@/lib/activities-db";
import { listBriefings, summarizeBriefings } from "@/lib/whatsapp-briefing-db";

export const dynamic = "force-dynamic";

const MODE_LABELS: Record<WhatsappOperationMode, string> = {
  passive: "🔇 Passivo",
  owner: "👤 Responder como você",
  assistant: "🤝 Responder como seu assessor",
  open: "🌐 Bot livre",
  pairing: "🔐 Pareamento manual",
};

function detectMode(): { operationMode: WhatsappOperationMode; dmPolicy: string } {
  // Prefer the local per-account record (authoritative for what the UI saved).
  const local = getWhatsappAccountLocal("main");
  if (local.operationMode) {
    return { operationMode: local.operationMode, dmPolicy: "" };
  }
  // Fall back to sniffing channels.whatsapp.* from openclaw.json — same logic
  // the modal's GET inference uses.
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const wa = raw?.channels?.whatsapp || {};
      const dm = wa.dmPolicy || "disabled";
      if (dm === "open") {
        const prefix = typeof wa.messagePrefix === "string" ? wa.messagePrefix : "";
        if (prefix.includes("[MODO ASSESSOR")) return { operationMode: "assistant", dmPolicy: dm };
        if (prefix.includes("[MODO PESSOAL")) return { operationMode: "owner", dmPolicy: dm };
        return { operationMode: "open", dmPolicy: dm };
      }
      if (dm === "pairing") return { operationMode: "pairing", dmPolicy: dm };
      return { operationMode: "passive", dmPolicy: dm };
    }
  } catch {
    // ignore — fall through
  }
  return { operationMode: "passive", dmPolicy: "disabled" };
}

export async function GET() {
  // Sync-on-read first so totals below reflect freshly-ingested transcripts.
  try {
    const { maybeIngestOnRead } = await import("@/lib/whatsapp-briefing-ingester");
    maybeIngestOnRead();
  } catch {
    /* ingester optional */
  }

  const mode = detectMode();

  // Activity in the last 24h that mentions WhatsApp. Catches config edits,
  // rotations, mode changes, repair runs — anything that PROVES the bot or
  // user touched WhatsApp recently. Helps disambiguate "bot is dead" from
  // "bot is alive but not logging".
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = getActivities({ search: "WhatsApp", startDate: sinceIso, limit: 100 });
  const last24hCount = recent.activities.length;
  const last = recent.activities[0] || null;

  // Briefing totals (across all time + pending right now).
  const pending = summarizeBriefings();
  const allBriefings = listBriefings({ limit: 1 });
  const lastBriefing = allBriefings[0] || null;
  // We don't have a cheap count(*) helper exposed; reuse summarize+listBriefings
  // and accept that a heavy briefing db (>1000 rows) won't show "total ever".
  // Estimate via summary.totalPending + (acked rows are intentionally ignored).
  // For accuracy, do a focused listBriefings without pending filter, limit high.
  const last500 = listBriefings({ limit: 500 });
  const totalEver = last500.length;

  // Compute hints. ORDER MATTERS, but the history fact (totalEver) is reported
  // FIRST when it exists — the briefing is now reconstructed from OpenClaw
  // session transcripts (the ingester), so historical conversations show up
  // regardless of the current operation mode. The passive-mode note is then
  // ADDED as complementary context, never as a replacement that hides history.
  const hints: string[] = [];

  if (totalEver > 0) {
    // We DO have reconstructed history — lead with it so passive mode no
    // longer makes the page look empty/misleading.
    if (pending.totalPending > 0) {
      hints.push(
        `${totalEver} conversa(s) reconstruída(s) do histórico do WhatsApp, ${pending.totalPending} ainda não revisada(s). Abra a lista abaixo pra auditar o que o bot recebeu e respondeu.`,
      );
    } else {
      hints.push(
        `Tudo em dia: ${totalEver} conversa(s) reconstruída(s) do histórico, nenhuma pendente de revisão.`,
      );
    }
    if (mode.operationMode === "passive") {
      hints.push(
        "🔇 Modo Passivo agora: o bot está conectado mas NÃO responde mensagens novas (dmPolicy=disabled). O histórico abaixo é o que ele já fez quando estava em Owner/Assessor/Open. Mude o modo se quiser que ele volte a responder.",
      );
    }
  } else if (mode.operationMode === "passive") {
    hints.push(
      "Modo atual: 🔇 Passivo. O bot está conectado mas NÃO responde mensagens (dmPolicy=disabled) — e não há histórico de conversas reconstruído. Mude pra Owner/Assessor/Open se quiser que ele responda; o que ele fizer será auditado aqui automaticamente.",
    );
  } else if (mode.operationMode === "pairing") {
    hints.push(
      "Modo atual: 🔐 Pareamento. O gateway está distribuindo códigos de pareamento e não passa mensagens normais pro agente — sem conversas esperadas.",
    );
  } else {
    // Active mode, no reconstructed history.
    hints.push(
      `Modo atual: ${MODE_LABELS[mode.operationMode]}. Nenhuma conversa de WhatsApp encontrada no histórico do agente. Possível causa: bot não recebeu mensagens de pessoas reais, OU canal desativado, OU sessão Baileys caiu. Confira o ⚙ WhatsApp setup.`,
    );
    if (last24hCount > 0) {
      hints.push(
        `Detectei ${last24hCount} evento(s) de WhatsApp (config/rotação) nas últimas 24h, mas nenhuma conversa de pessoa — se você esperava mensagens, confirme que o gateway está recebendo e que a sessão não caiu.`,
      );
    }
  }

  return NextResponse.json({
    mode: {
      operationMode: mode.operationMode,
      label: MODE_LABELS[mode.operationMode],
      dmPolicy: mode.dmPolicy,
    },
    activity: {
      last24hCount,
      lastTimestamp: last?.timestamp ?? null,
      lastDescription: last?.description ?? null,
    },
    briefings: {
      totalEver,
      lastTimestamp: lastBriefing?.createdAt ?? null,
      pendingCount: pending.totalPending,
    },
    hints,
  });
}
