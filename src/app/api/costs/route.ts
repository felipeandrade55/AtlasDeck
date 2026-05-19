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
} from "@/lib/usage-queries";
import { collectUsage, initDatabase, type CollectionResult } from "@/lib/usage-collector";
import { MODEL_PRICING } from "@/lib/pricing";
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

function readCostsResponse(days: number, collection: CollectionResult | null, collectionError: string | null, intervalMs: number) {
  const db = initDatabase(DB_PATH);

  try {
    const summary = getCostSummary(db);
    const settings = getCostSettings(db);
    const metadata = getCollectionMetadata(db);
    const totals = getUsageTotals(db, days);

    const status = collectionError
      ? metadata.lastSnapshotAt
        ? "stale"
        : "unavailable"
      : collection
        ? "fresh"
        : metadata.lastSnapshotAt
          ? "cached"
          : "empty";

    return {
      ...summary,
      budget: settings.budget,
      alertThreshold: settings.alertThreshold,
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
        error: collectionError,
        autoCollectIntervalMs: intervalMs,
        ...metadata,
      },
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

    return NextResponse.json(readCostsResponse(days, collection, collectionError, intervalMs));
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
      const settings = setCostSettings(db, {
        budget: body.budget === undefined ? undefined : Number(body.budget),
        alertThreshold: body.alertThreshold === undefined ? undefined : Number(body.alertThreshold),
      });

      return NextResponse.json({
        success: true,
        ...settings,
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
