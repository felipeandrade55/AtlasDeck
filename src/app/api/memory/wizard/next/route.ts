/**
 * Wizard interview: receives current history + last answer, asks the
 * LLM for the next question (or signals completion).
 *
 * POST /api/memory/wizard/next
 * Body: { history: [{question, answer}, ...] }
 */
import { NextRequest, NextResponse } from "next/server";
import { buildInterviewerPrompt, type InterviewerOutput, type WizardTurn } from "@/lib/wizard-prompts";
import { runWizardLLM } from "@/lib/wizard-llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIRST_QUESTION = "Pra começar, qual é o seu nome e o que você faz no dia a dia?";

export async function POST(request: NextRequest) {
  let body: { history?: WizardTurn[] };
  try {
    body = (await request.json()) as { history?: WizardTurn[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];

  // Bootstrap: if no history yet, return a curated opener without
  // hitting the LLM. Keeps first-render snappy and free.
  if (history.length === 0) {
    return NextResponse.json({
      complete: false,
      next_question: FIRST_QUESTION,
      covered: [],
      provider: "bootstrap",
      model: "static",
    });
  }

  try {
    const prompt = buildInterviewerPrompt(history);
    const { data, provider, model } = await runWizardLLM<InterviewerOutput>(prompt);

    if (typeof data?.complete !== "boolean") {
      throw new Error("LLM não retornou campo 'complete'");
    }

    return NextResponse.json({
      ...data,
      provider,
      model,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Wizard failed",
        hint:
          "Verifique se o Ollama está rodando (Memória → Configurações → Extrator de memórias) ou se o OpenClaw CLI está acessível.",
      },
      { status: 503 },
    );
  }
}
