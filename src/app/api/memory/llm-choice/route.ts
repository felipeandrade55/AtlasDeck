/**
 * LLM provider choice for the onboarding wizard.
 *
 * GET  /api/memory/llm-choice
 *   Returns the current state so the UI can decide whether to show the
 *   choice step:
 *     - choice_made: user has answered (or system inferred a working setup)
 *     - extractor_provider: the active preference
 *     - ollama: { installed, running, has_recommended_model }
 *     - openclaw: { configured, bin_exists }
 *
 * POST /api/memory/llm-choice
 *   Body: { choice: "ollama" | "openclaw" | "later" }
 *   Persists the user's pick and flips llm_choice_made=true. For "later"
 *   it only marks the choice as deferred — the actual extractor_provider
 *   stays whatever was already in settings (default openclaw).
 */
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings } from "@/lib/memory-db";
import { getOllamaStatus } from "@/lib/ollama-client";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function openclawBinExists(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      return fs.existsSync(bin);
    } catch {
      return false;
    }
  }
  // Bare name like "openclaw" — assume it's on PATH. We can't cheaply
  // verify without spawning a child, so we report "configured" and let
  // the wizard call surface the actual error if absent.
  return true;
}

export async function GET() {
  const settings = getSettings();
  const ollama = await getOllamaStatus().catch(() => null);
  const openclawConfig = readOpenClawConfig();

  const recommendedModel = settings.ollama_model;
  const hasRecommendedModel = ollama
    ? ollama.models.some(
        (m) =>
          m.name === recommendedModel ||
          m.name.startsWith(recommendedModel.split(":")[0]),
      )
    : false;

  const openclawConfigured =
    openclawConfig.sources.bin !== "default" ||
    openclawConfig.sources.dir !== "default";

  return NextResponse.json({
    choice_made: settings.llm_choice_made,
    extractor_provider: settings.extractor_provider,
    ollama_model: settings.ollama_model,
    ollama: ollama
      ? {
          installed: ollama.installed,
          running: ollama.running,
          has_recommended_model: hasRecommendedModel,
          models_count: ollama.models.length,
        }
      : { installed: false, running: false, has_recommended_model: false, models_count: 0 },
    openclaw: {
      configured: openclawConfigured,
      bin: openclawConfig.openclawBin,
      bin_exists: openclawBinExists(openclawConfig.openclawBin),
    },
  });
}

export async function POST(request: NextRequest) {
  let body: { choice?: string };
  try {
    body = (await request.json()) as { choice?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const choice = body.choice;
  if (choice !== "ollama" && choice !== "openclaw" && choice !== "later") {
    return NextResponse.json(
      { error: "choice must be 'ollama' | 'openclaw' | 'later'" },
      { status: 400 },
    );
  }

  const patch: Parameters<typeof setSettings>[0] = { llm_choice_made: true };
  if (choice === "ollama") patch.extractor_provider = "ollama";
  if (choice === "openclaw") patch.extractor_provider = "openclaw";

  const next = setSettings(patch);
  return NextResponse.json({ success: true, choice, settings: next });
}
