import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import {
  getCollectionMetadata,
  getCostByAgent,
  getCostByModel,
  getCostBySession,
  getCostSettings,
  getCostSummary,
  getDailyCost,
  getHourlyCost,
  getUsageTotals,
  setCostSettings,
  getCurrentCostForTimeframe,
} from "@/lib/usage-queries";
import { collectUsage, initDatabase, type CollectionResult, getOpenClawDiagnostics } from "@/lib/usage-collector";
import { MODEL_PRICING } from "@/lib/pricing";
import { addNotification } from "@/lib/notifications";
import { sendTelegramAlert } from "@/lib/telegram";
import { logActivity } from "@/lib/activities-db";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PATH = path.join(process.cwd(), "data", "usage-tracking.db");
const DEFAULT_COLLECT_INTERVAL_MS = 60_000;

function parseDays(timeframe: string | null): number {
  const days = Number.parseInt((timeframe || "30d").replace(/\D/g, ""), 10);
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(days, 1), 365);
}

function parseInterval(): number {
  const configured = Number(process.env.COST_AUTO_COLLECT_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 15_000
    ? configured
    : DEFAULT_COLLECT_INTERVAL_MS;
}

function wantsRefresh(request: NextRequest): boolean {
  const value = request.nextUrl.searchParams.get("refresh");
  return value === "1" || value === "true";
}

function allowsAutoCollect(request: NextRequest): boolean {
  const value = request.nextUrl.searchParams.get("collect");
  return value !== "0" && value !== "false";
}

function shouldCollect(lastCollectedAt: number | null, intervalMs: number, force: boolean): boolean {
  if (force) return true;
  if (!lastCollectedAt) return true;
  return Date.now() - lastCollectedAt >= intervalMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function evaluateCostAlerts(db: any) {
  try {
    const settings = getCostSettings(db);
    const timeframe = settings.limitTimeframe || 'monthly';
    const limit = settings.limitUsd || settings.budget;
    const current = getCurrentCostForTimeframe(db, timeframe);
    const alertThresholdPercent = settings.alertThreshold || 80;

    let newState: 'none' | 'warning' | 'exceeded' = 'none';
    if (current >= limit) {
      newState = 'exceeded';
    } else if (current >= limit * (alertThresholdPercent / 100)) {
      newState = 'warning';
    }

    if (newState !== settings.lastAlertState) {
      const timeframeLabels = {
        daily: 'diário',
        weekly: 'semanal',
        monthly: 'mensal',
      };
      
      const label = timeframeLabels[timeframe];
      const pct = limit > 0 ? (current / limit) * 100 : 0;

      if (newState === 'warning') {
        const title = "⚠️ Limite de Custos Próximo";
        const message = `Atenção: Seu consumo ${label} atingiu ${pct.toFixed(1)}% do limite configurado ($${current.toFixed(2)} de $${limit.toFixed(2)}).`;
        
        // Local Notification
        await addNotification(title, message, 'warning', '/costs');
        
        // Telegram Alert
        const telegramMessage = `<b>⚠️ AtlasDeck: Limite de Custos Próximo</b>\n\nSeu consumo <b>${label}</b> atingiu <b>${pct.toFixed(1)}%</b> do limite configurado.\n\n• Consumido: <b>$${current.toFixed(2)}</b>\n• Limite: <b>$${limit.toFixed(2)}</b>`;
        await sendTelegramAlert(settings.telegramBotToken, settings.telegramChatId, telegramMessage);
      } else if (newState === 'exceeded') {
        const isLocked = settings.behaviorMode === 'alert_and_lock';
        const title = isLocked ? "🚨 Limite Excedido & Trava Ativada" : "🚨 Limite de Custos Excedido";
        const message = `Alerta Crítico: Seu consumo ${label} de $${current.toFixed(2)} excedeu o limite de $${limit.toFixed(2)}.${isLocked ? ' A trava de segurança foi ativada e suspendeu execuções.' : ''}`;
        
        // Local Notification
        await addNotification(title, message, 'error', '/costs');
        
        // Telegram Alert
        const telegramMessage = `<b>🚨 AtlasDeck: Limite de Custos Excedido</b>\n\nSeu consumo <b>${label}</b> de <b>$${current.toFixed(2)}</b> excedeu o limite configurado de <b>$${limit.toFixed(2)}</b>.\n\n${isLocked ? '🔒 <b>A trava de segurança foi ativada</b> e suspendeu novas execuções de agentes.' : '⚠️ Nenhuma trava ativada.'}`;
        await sendTelegramAlert(settings.telegramBotToken, settings.telegramChatId, telegramMessage);
      } else if (newState === 'none' && settings.lastAlertState !== 'none') {
        // Recovered back to safe limits
        const title = "✅ Custos Normalizados";
        const message = `Seu consumo ${label} está novamente abaixo dos limites de alerta.`;
        
        await addNotification(title, message, 'success', '/costs');
        
        const telegramMessage = `<b>✅ AtlasDeck: Custos Normalizados</b>\n\nSeu consumo <b>${label}</b> de <b>$${current.toFixed(2)}</b> está novamente abaixo dos limites configurados (Limite: <b>$${limit.toFixed(2)}</b>).`;
        await sendTelegramAlert(settings.telegramBotToken, settings.telegramChatId, telegramMessage);
      }

      // Persist the state change
      setCostSettings(db, { lastAlertState: newState });
    }
  } catch (err) {
    console.error("Error evaluating cost alerts:", err);
  }
}

function pricingTable() {
  return MODEL_PRICING.map((model) => ({
    id: model.id,
    name: model.name,
    alias: model.alias ?? null,
    input: model.inputPricePerMillion,
    output: model.outputPricePerMillion,
    contextWindow: model.contextWindow,
  }));
}

async function readCostsResponse(days: number, collection: CollectionResult | null, collectionError: string | null, intervalMs: number) {
  const db = initDatabase(DB_PATH);

  try {
    const summary = getCostSummary(db);
    const settings = getCostSettings(db);
    const metadata = getCollectionMetadata(db);
    const totals = getUsageTotals(db, days);
    const timeframe = settings.limitTimeframe || 'monthly';
    const limit = settings.limitUsd || settings.budget;
    const currentCost = getCurrentCostForTimeframe(db, timeframe);
    const isLocked = settings.behaviorMode === 'alert_and_lock' && currentCost >= limit;

    // Use the persisted error from DB if no collection was attempted and there is one
    const effectiveError = collectionError
      ?? (!collection && metadata.lastCollectionError ? metadata.lastCollectionError : null);

    const status = effectiveError
      ? metadata.lastSnapshotAt
        ? "stale"
        : "unavailable"
      : collection
        ? "fresh"
        : metadata.lastSnapshotAt
          ? "cached"
          : "empty";

    // Include diagnostics when collection failed or data is stale/empty
    let diagnostics = null;
    if (status === "unavailable" || status === "empty" || status === "stale" || effectiveError) {
      try {
        diagnostics = await getOpenClawDiagnostics();
      } catch {
        diagnostics = null;
      }
    }

    return {
      ...summary,
      budget: settings.budget,
      alertThreshold: settings.alertThreshold,
      limitTimeframe: settings.limitTimeframe,
      limitUsd: settings.limitUsd,
      behaviorMode: settings.behaviorMode,
      telegramBotToken: settings.telegramBotToken ? "configured" : "",
      telegramChatId: settings.telegramChatId,
      isLocked,
      timeframeCost: currentCost,
      totals,
      byAgent: getCostByAgent(db, days),
      byModel: getCostByModel(db, days),
      bySession: getCostBySession(db, days),
      daily: getDailyCost(db, days),
      hourly: getHourlyCost(db),
      pricing: pricingTable(),
      collection: {
        status,
        lastRun: collection,
        error: effectiveError,
        autoCollectIntervalMs: intervalMs,
        ...metadata,
      },
      diagnostics,
    };
  } finally {
    db.close();
  }
}

export async function GET(request: NextRequest) {
  const days = parseDays(request.nextUrl.searchParams.get("timeframe"));
  const intervalMs = parseInterval();
  let collection: CollectionResult | null = null;
  let collectionError: string | null = null;

  try {
    const db = initDatabase(DB_PATH);
    const metadata = getCollectionMetadata(db);
    db.close();

    if (allowsAutoCollect(request) && shouldCollect(metadata.lastCollectedAt, intervalMs, wantsRefresh(request))) {
      try {
        collection = await collectUsage(DB_PATH);
      } catch (error) {
        collectionError = errorMessage(error);
      }
    }

    // Evaluate alerts to trigger Telegram/Local notifications dynamically
    const db2 = initDatabase(DB_PATH);
    try {
      await evaluateCostAlerts(db2);
    } catch (e) {
      console.error("Failed to evaluate cost alerts in GET:", e);
    } finally {
      db2.close();
    }

    return NextResponse.json(await readCostsResponse(days, collection, collectionError, intervalMs));
  } catch (error) {
    console.error("Error fetching cost data:", error);
    return NextResponse.json(
      { error: "Failed to fetch cost data", detail: errorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      budget?: number | string;
      alertThreshold?: number | string;
      limitTimeframe?: 'daily' | 'weekly' | 'monthly';
      limitUsd?: number | string;
      behaviorMode?: 'alert_only' | 'alert_and_lock';
      telegramBotToken?: string;
      telegramChatId?: string;
    };

    if (body.action === "collect") {
      const collection = await collectUsage(DB_PATH);
      return NextResponse.json({
        success: true,
        collection,
      });
    }

    const db = initDatabase(DB_PATH);
    try {
      const currentSettings = getCostSettings(db);
      let tokenValue = body.telegramBotToken;
      if (tokenValue === "configured") {
        tokenValue = currentSettings.telegramBotToken;
      }

      const settings = setCostSettings(db, {
        budget: body.budget === undefined ? undefined : Number(body.budget),
        alertThreshold: body.alertThreshold === undefined ? undefined : Number(body.alertThreshold),
        limitTimeframe: body.limitTimeframe,
        limitUsd: body.limitUsd === undefined ? undefined : Number(body.limitUsd),
        behaviorMode: body.behaviorMode,
        telegramBotToken: tokenValue,
        telegramChatId: body.telegramChatId,
      });

      // Instantly evaluate alerts after changes
      await evaluateCostAlerts(db);

      logActivity(
        'config',
        `Configurações de orçamento atualizadas${settings.limitUsd ? ` (limite: $${settings.limitUsd}/${settings.limitTimeframe || 'monthly'})` : ''}`,
        'success',
        { metadata: { budget: settings.budget, alertThreshold: settings.alertThreshold, limitTimeframe: settings.limitTimeframe, behaviorMode: settings.behaviorMode } }
      );

      return NextResponse.json({
        success: true,
        ...settings,
        telegramBotToken: settings.telegramBotToken ? "configured" : "",
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("Error updating cost settings:", error);
    return NextResponse.json(
      { error: "Failed to update cost settings", detail: errorMessage(error) },
      { status: 400 }
    );
  }
}
