/**
 * GET  /api/openclaw/agents-config
 *   Returns the GLOBAL agents-level defaults from openclaw.json:
 *     - defaults.model.primary
 *     - defaults.model.fallback (read from either `.fallback` or first of `.fallbacks`)
 *     - defaults.compaction.reserveTokensFloor
 *     - shape hints so PUT can preserve the original layout
 *
 * PUT  /api/openclaw/agents-config
 *   Body: { primary?: string; fallback?: string|null; reserveTokensFloor?: number|null }
 *   Surgical merge — never replaces or rewrites unknown fields in openclaw.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";
import { validateModelId } from "@/lib/openclaw-models";

export const dynamic = "force-dynamic";

interface DefaultsView {
  primary: string;
  fallback: string | null;
  fallbackShape: "string" | "array" | "none";
  reserveTokensFloor: number | null;
  isFallbackConfig: boolean;
  configPath: string;
}

function readFallbackString(modelObj: unknown): { value: string | null; shape: "string" | "array" | "none" } {
  if (!modelObj || typeof modelObj !== "object") return { value: null, shape: "none" };
  const obj = modelObj as { fallback?: unknown; fallbacks?: unknown };
  if (typeof obj.fallback === "string" && obj.fallback.trim()) {
    return { value: obj.fallback.trim(), shape: "string" };
  }
  if (Array.isArray(obj.fallbacks)) {
    const first = obj.fallbacks.find((x): x is string => typeof x === "string" && x.trim().length > 0);
    return { value: first ? first.trim() : null, shape: "array" };
  }
  return { value: null, shape: "none" };
}

export async function GET() {
  try {
    const { path: configPath, isFallback } = resolveOpenClawAgentsConfigPath();
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    const defaultsModel = config.agents?.defaults?.model;
    const fb = readFallbackString(defaultsModel);
    const reserve = config.agents?.defaults?.compaction?.reserveTokensFloor;

    const view: DefaultsView = {
      primary: typeof defaultsModel?.primary === "string"
        ? defaultsModel.primary
        : "openai/gpt-5.5-codex",
      fallback: fb.value,
      fallbackShape: fb.shape,
      reserveTokensFloor: typeof reserve === "number" ? reserve : null,
      isFallbackConfig: isFallback,
      configPath,
    };

    return NextResponse.json(view, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      primary?: string;
      fallback?: string | null;
      reserveTokensFloor?: number | null;
    };

    // ── Validation ────────────────────────────────────────────────
    if (body.primary !== undefined) {
      if (typeof body.primary !== "string" || !body.primary.trim()) {
        return NextResponse.json({ error: "primary inválido" }, { status: 400 });
      }
      const w = validateModelId(body.primary);
      if (w?.level === "error") {
        return NextResponse.json({ error: w.message, field: "primary" }, { status: 400 });
      }
    }
    if (body.fallback !== undefined && body.fallback !== null && body.fallback !== "") {
      if (typeof body.fallback !== "string") {
        return NextResponse.json({ error: "fallback inválido" }, { status: 400 });
      }
      const w = validateModelId(body.fallback);
      if (w?.level === "error") {
        return NextResponse.json({ error: w.message, field: "fallback" }, { status: 400 });
      }
    }
    if (body.reserveTokensFloor !== undefined && body.reserveTokensFloor !== null) {
      const n = Number(body.reserveTokensFloor);
      if (!Number.isFinite(n) || n < 1000 || n > 200000) {
        return NextResponse.json(
          { error: "reserveTokensFloor deve estar entre 1000 e 200000" },
          { status: 400 },
        );
      }
    }

    // ── Read, patch surgically, write ─────────────────────────────
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    config.agents.defaults.compaction = config.agents.defaults.compaction || {};

    const changedFields: string[] = [];
    const modelObj = config.agents.defaults.model;

    if (body.primary !== undefined) {
      modelObj.primary = body.primary.trim();
      changedFields.push("primary");
    }

    if (body.fallback !== undefined) {
      const fb = body.fallback === null ? "" : String(body.fallback).trim();
      // Preserve original shape: if file used `.fallbacks` array, keep array.
      if (Array.isArray(modelObj.fallbacks)) {
        modelObj.fallbacks = fb ? [fb] : [];
      } else if (fb) {
        modelObj.fallback = fb;
      } else {
        delete modelObj.fallback;
      }
      changedFields.push("fallback");
    }

    if (body.reserveTokensFloor !== undefined) {
      if (body.reserveTokensFloor === null) {
        delete config.agents.defaults.compaction.reserveTokensFloor;
      } else {
        config.agents.defaults.compaction.reserveTokensFloor = Number(body.reserveTokensFloor);
      }
      changedFields.push("reserveTokensFloor");
    }

    if (changedFields.length === 0) {
      return NextResponse.json({ success: true, changed: [] });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    try {
      logActivity(
        "config",
        `OpenClaw defaults atualizados (${changedFields.join(", ")})`,
        "success",
        { metadata: { fields: changedFields } },
      );
    } catch {}

    return NextResponse.json({ success: true, changed: changedFields });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
