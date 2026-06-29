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

// Full ordered question plan (opener + follow-ups). The static path
// walks this list, always picking the first question not yet asked, so
// it can never repeat a question regardless of how the history grew.
const STATIC_QUESTIONS = [
  FIRST_QUESTION,
  "Qual é a sua stack técnica? Quais linguagens, frameworks e ferramentas você usa no dia a dia?",
  "Como você prefere se comunicar com o agente? Respostas curtas ou detalhadas? Tom formal ou informal?",
  "Pensa num nome e numa 'vibe' pro seu agente — como você quer que ele seja: direto, analítico, criativo? Tem algum limite que ele não deve cruzar?",
  "Qual é o seu projeto principal agora? O que você está construindo e qual é o foco atual?",
];

const normalizeQ = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

// First question in the plan the user hasn't been asked yet (null when
// every topic is covered → wizard completes).
function nextStaticQuestion(history: WizardTurn[]): string | null {
  const asked = new Set(history.map((h) => normalizeQ(h.question)));
  return STATIC_QUESTIONS.find((q) => !asked.has(normalizeQ(q))) ?? null;
}

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

  const asked = new Set(history.map((h) => normalizeQ(h.question)));

  // The interview is STATIC by default: instant, deterministic, and the 5
  // curated questions already cover every topic. We deliberately do NOT
  // call the LLM here — a real agent turn takes ~10-15s, which would make
  // every "Próxima" click crawl (and get killed by any timeout, wasting
  // the wait + tokens). The LLM's real value is the GENERATE step, which
  // synthesizes the files. Opt into an adaptive LLM interview by setting
  // WIZARD_LLM_INTERVIEW=1 (accepts the per-question latency).
  if (process.env.WIZARD_LLM_INTERVIEW === "1") {
    try {
      const prompt = buildInterviewerPrompt(history);
      const { data, provider, model } = await runWizardLLM<InterviewerOutput>(prompt, {
        timeoutMs: 30_000,
      });

      if (typeof data?.complete !== "boolean") {
        throw new Error("LLM não retornou campo 'complete'");
      }

      // Guard against a weak model that re-asks a covered question (or
      // returns an empty one): treat it as "needs static fallback".
      const proposed = data.next_question?.trim();
      if (!data.complete && (!proposed || asked.has(normalizeQ(proposed)))) {
        throw new Error("LLM repetiu/omitiu a pergunta");
      }

      return NextResponse.json({ ...data, provider, model });
    } catch {
      // fall through to the static plan below
    }
  }

  // Static plan — always pick a question that hasn't been asked yet.
  {
    const next = nextStaticQuestion(history);
    if (next) {
      return NextResponse.json({
        complete: false,
        next_question: next,
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
