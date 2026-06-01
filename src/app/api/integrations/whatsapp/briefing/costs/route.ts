/**
 * GET /api/integrations/whatsapp/briefing/costs?sinceMs=...&agent=main
 *
 * Returns a per-briefing cost estimate by correlating `usage_snapshots`
 * (LLM token bills) with `assessor_conversations.created_at` via NON-
 * OVERLAPPING windows: each briefing claims the cost between its own
 * createdAt and the next briefing's createdAt (capped at +60s so a long
 * idle gap doesn't tag the whole stretch onto one entry).
 *
 * Returns: { ok, costs: { [briefingId]: { cost, totalTokens, ... } } }
 *
 * Response shape is keyed by briefingId so the frontend can merge with
 * the existing /briefing GET response client-side instead of re-fetching
 * everything. Cost is an ESTIMATE — when conversations overlap or the
 * agent does background work, attribution is imperfect.
 */
import { NextRequest, NextResponse } from "next/server";
import { listBriefings } from "@/lib/whatsapp-briefing-db";
import { getDatabase, getSnapshotsInRange } from "@/lib/usage-queries";

export const dynamic = "force-dynamic";

// Look-back margin to catch snapshots written slightly BEFORE the briefing
// (LLM call finishes + tokens recorded a few hundred ms before the agent
// gets to call the briefing tool). 5s covers normal jitter.
const LOOKBACK_MS = 5_000;

// Cap each briefing's claim window at this many seconds after createdAt.
// Without a cap, the last briefing of a quiet evening would absorb every
// background snapshot until the next conversation hours later.
const MAX_WINDOW_MS = 60_000;

interface CostEstimate {
  cost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  snapshotCount: number;
  /** Most-frequent model in the window (best-effort label for the UI). */
  model: string | null;
  /** Window actually used [startMs, endMs] — useful for debugging. */
  windowMs: { start: number; end: number };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("sinceMs");
  const accountId = url.searchParams.get("accountId") || undefined;
  const agentId = url.searchParams.get("agent") || "main";
  const limit = Number(url.searchParams.get("limit") || 500);

  const sinceMs = sinceParam ? Number(sinceParam) : Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Pull briefings ordered ASC by createdAt — necessary for the non-
  // overlapping window logic. listBriefings returns DESC; we sort below.
  const briefings = listBriefings({ accountId, sinceMs, limit });
  if (briefings.length === 0) {
    return NextResponse.json({ ok: true, costs: {}, snapshotCount: 0 });
  }
  const asc = [...briefings].sort((a, b) => a.createdAt - b.createdAt);

  // Open usage-tracking.db. If absent (fresh install / never collected),
  // gracefully return empty rather than 500 — costs are best-effort.
  const db = getDatabase();
  if (!db) {
    return NextResponse.json({
      ok: true,
      costs: {},
      snapshotCount: 0,
      note: "usage-tracking.db ausente — sem dados de custo ainda.",
    });
  }

  try {
    // One bulk query for the whole range, then JS-bucket per briefing.
    // Range covers slightly before the first briefing (LOOKBACK) and a
    // bit after the last (MAX_WINDOW to capture trailing tool calls).
    const rangeStart = asc[0].createdAt - LOOKBACK_MS;
    const rangeEnd = asc[asc.length - 1].createdAt + MAX_WINDOW_MS;
    const snapshots = getSnapshotsInRange(db, rangeStart, rangeEnd, agentId);

    const result: Record<string, CostEstimate> = {};
    for (let i = 0; i < asc.length; i++) {
      const b = asc[i];
      const winStart = b.createdAt - LOOKBACK_MS;
      // Cap window by either the next briefing's createdAt (so we don't
      // double-count cost) or MAX_WINDOW_MS, whichever is smaller.
      const nextStart =
        i + 1 < asc.length ? asc[i + 1].createdAt - LOOKBACK_MS : Number.POSITIVE_INFINITY;
      const winEnd = Math.min(b.createdAt + MAX_WINDOW_MS, nextStart - 1);

      let cost = 0;
      let totalTokens = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let snapshotCount = 0;
      const modelCounts: Record<string, number> = {};

      // Linear scan is fine — snapshots are sorted, and N is small in
      // practice (a single conversation rarely has >5 snapshots).
      for (const s of snapshots) {
        if (s.timestampMs < winStart) continue;
        if (s.timestampMs > winEnd) break;
        cost += s.cost;
        totalTokens += s.totalTokens;
        inputTokens += s.inputTokens;
        outputTokens += s.outputTokens;
        snapshotCount += 1;
        if (s.model) modelCounts[s.model] = (modelCounts[s.model] ?? 0) + 1;
      }

      const topModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      result[b.id] = {
        cost: Number(cost.toFixed(6)),
        totalTokens,
        inputTokens,
        outputTokens,
        snapshotCount,
        model: topModel,
        windowMs: { start: winStart, end: winEnd },
      };
    }

    return NextResponse.json({
      ok: true,
      costs: result,
      snapshotCount: snapshots.length,
      range: { startMs: rangeStart, endMs: rangeEnd },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    db.close();
  }
}
