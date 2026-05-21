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

// Fallback questions used when no LLM provider is available.
// Index 0 = question asked when history.length === 1 (after FIRST_QUESTION).
const STATIC_FOLLOWUPS = [
  "Qual é a sua stack técnica? Quais linguagens, frameworks e ferramentas você usa no dia a dia?",
  "Como você prefere se comunicar com o agente? Respostas curtas ou detalhadas? Tom formal ou informal?",
  "Pensa num nome e numa 'vibe' pro seu agente — como você quer que ele seja: direto, analítico, criativo? Tem algum limite que ele não deve cruzar?",
  "Qual é o seu projeto principal agora? O que você está construindo e qual é o foco atual?",
];

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
  } catch {
    // LLM unavailable — fall back to the static question list so the
    // wizard never gets stuck showing the same question twice.
    const fallbackIndex = history.length - 1;
    if (fallbackIndex < STATIC_FOLLOWUPS.length) {
      return NextResponse.json({
        complete: false,
        next_question: STATIC_FOLLOWUPS[fallbackIndex],
        covered: [],
        provider: "bootstrap",
        model: "static",
      });
    }
    // All static topics covered — signal completion.
    return NextResponse.json({
      complete: true,
      summary: "Coletei informações suficientes para configurar sua memória.",
      provider: "bootstrap",
      model: "static",
    });
  }
}
