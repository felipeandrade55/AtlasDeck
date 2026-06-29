/**
 * Wizard generation step: given the full Q&A history, ask the LLM to
 * synthesize IDENTITY.md / SOUL.md / USER.md content. Returns drafts
 * — the user reviews + saves via /save in a separate step.
 *
 * POST /api/memory/wizard/generate
 * Body: { history: [{question, answer}, ...] }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  buildGeneratorPrompt,
  buildFallbackFiles,
  type GeneratedFiles,
  type WizardTurn,
} from "@/lib/wizard-prompts";
import { runWizardLLM } from "@/lib/wizard-llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { history?: WizardTurn[] };
  try {
    body = (await request.json()) as { history?: WizardTurn[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  if (history.length === 0) {
    return NextResponse.json(
      { error: "Histórico vazio — colete respostas antes de gerar" },
      { status: 400 },
    );
  }

  try {
    const prompt = buildGeneratorPrompt(history);
    const { data, provider, model } = await runWizardLLM<GeneratedFiles>(prompt, {
      timeoutMs: 45_000,
    });

    const required: Array<keyof GeneratedFiles> = ["IDENTITY.md", "SOUL.md", "USER.md"];
    for (const key of required) {
      if (typeof data?.[key] !== "string" || !data[key].trim()) {
        throw new Error(`LLM não gerou ${key}`);
      }
    }

    return NextResponse.json({
      files: data,
      provider,
      model,
    });
  } catch (err) {
    // No LLM reachable (or it returned garbage). Instead of a hard 503
    // that strands the user at the finish line, hand back a deterministic
    // scaffold built from their answers. They review + edit it next, and
    // can hit "Regerar" later once a provider is available.
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[wizard/generate] LLM failed, using template fallback:", err);
    }
    return NextResponse.json({
      files: buildFallbackFiles(history),
      provider: "template",
      model: "fallback",
      fallback: true,
    });
  }
}
