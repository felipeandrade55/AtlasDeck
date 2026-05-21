/**
 * Wizard generation step: given the full Q&A history, ask the LLM to
 * synthesize IDENTITY.md / SOUL.md / USER.md content. Returns drafts
 * — the user reviews + saves via /save in a separate step.
 *
 * POST /api/memory/wizard/generate
 * Body: { history: [{question, answer}, ...] }
 */
import { NextRequest, NextResponse } from "next/server";
import { buildGeneratorPrompt, type GeneratedFiles, type WizardTurn } from "@/lib/wizard-prompts";
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
    const { data, provider, model } = await runWizardLLM<GeneratedFiles>(prompt);

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
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Generation failed",
      },
      { status: 503 },
    );
  }
}
