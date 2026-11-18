/**
 * What the assistant has learned — for review and correction in the UI
 * (Memória → Aprendizado). Everything learned automatically is visible
 * and editable here.
 *
 * GET  /api/memory/learning
 * POST /api/memory/learning { action, ... }
 *   refute-learning {id} | delete-learning {id} | add-learning {pattern}
 *   create-entity {type, name, summary?, brand?} | update-entity {id, name?, summary?, brand?, type?}
 *   delete-entity {id} | delete-deliverable {id} | run-reflection
 */
import { NextRequest, NextResponse } from "next/server";
import { deleteLearning, listLearnings, recordLearning, refuteLearning } from "@/lib/learnings-db";
import {
  deleteDeliverable,
  deleteEntity,
  ENTITY_TYPES,
  invalidateMentionCache,
  listDeliverables,
  listEntities,
  updateEntity,
  upsertEntity,
  type EntityType,
} from "@/lib/entity-db";
import { getSettingValue, listRecentJobs } from "@/lib/memory-db";
import { readProfile, runReflection } from "@/lib/reflection-job";
import { getOneShotStatus } from "@/lib/llm-oneshot";
import { bridgeLastSeen } from "@/lib/bridge-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE = "workspace";

export async function GET() {
  const preferences = listLearnings({ include_refuted: false, limit: 150 }).filter(
    (l) => l.source !== "approval" && l.source !== "implicit_sentiment",
  );
  return NextResponse.json({
    profile: readProfile(),
    preferences,
    entities: listEntities({ workspace: WORKSPACE, limit: 300 }),
    deliverables: listDeliverables({ workspace: WORKSPACE, limit: 100 }),
    reflection: {
      lastRun: getSettingValue("reflection_last_run"),
      jobs: listRecentJobs({ kind: "reflect", limit: 5 }),
    },
    extraction: { jobs: listRecentJobs({ kind: "extract", limit: 10 }), llm: getOneShotStatus() },
    bridge: { lastSeen: bridgeLastSeen() },
  });
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const id = str(body.id, 80);
  try {
    switch (body.action) {
      case "refute-learning":
        return NextResponse.json({ ok: Boolean(refuteLearning(id)) });
      case "delete-learning":
        return NextResponse.json({ ok: deleteLearning(id) });
      case "add-learning": {
        const pattern = str(body.pattern, 240);
        if (pattern.length < 4) return NextResponse.json({ error: "pattern required" }, { status: 400 });
        return NextResponse.json({
          ok: true,
          learning: recordLearning({ agent_id: null, pattern, source: "manual", confidence: 0.8, evidence: "painel" }),
        });
      }
      case "create-entity": {
        const name = str(body.name, 120);
        if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
        const type = ENTITY_TYPES.includes(body.type as EntityType) ? (body.type as EntityType) : "client";
        const entity = upsertEntity({ workspace: WORKSPACE, type, name, summary: str(body.summary, 600) || null, brand: body.brand });
        invalidateMentionCache();
        return NextResponse.json({ ok: true, entity });
      }
      case "update-entity": {
        const entity = updateEntity(id, {
          name: body.name !== undefined ? str(body.name, 120) : undefined,
          summary: body.summary !== undefined ? str(body.summary, 600) || null : undefined,
          aliases: Array.isArray(body.aliases) ? body.aliases.map(String).slice(0, 12) : undefined,
          brand: body.brand,
          type: ENTITY_TYPES.includes(body.type as EntityType) ? (body.type as EntityType) : undefined,
        });
        invalidateMentionCache();
        return entity ? NextResponse.json({ ok: true, entity }) : NextResponse.json({ error: "not found" }, { status: 404 });
      }
      case "delete-entity":
        invalidateMentionCache();
        return NextResponse.json({ ok: deleteEntity(id) });
      case "delete-deliverable":
        return NextResponse.json({ ok: deleteDeliverable(id) });
      case "run-reflection":
        return NextResponse.json({ ok: true, result: await runReflection({ force: true }) });
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
