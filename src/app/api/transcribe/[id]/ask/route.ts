/**
 * Q&A over a single transcription. Answers a free-text question grounded only
 * in the transcript text. Stateless (no history). Reuses the same LLM cascade
 * as the analyzer (OpenAI → OpenClaw → Ollama).
 */
import { NextRequest, NextResponse } from "next/server";
import { getTranscription } from "@/lib/transcriptions-db";
import { runLlmCascade } from "@/lib/transcription-analyzer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap the context injected into the prompt to avoid blowing the model window
// on multi-hour meetings. Summary + key points carry the gist; the truncated
// transcript provides detail. A future evolution would do RAG over chunks/FTS.
const MAX_CONTEXT_CHARS = 12_000;

function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Pergunta vazia" }, { status: 400 });
  }

  const fullText = t.text || "";
  const truncated = fullText.length > MAX_CONTEXT_CHARS;
  const context = truncated ? fullText.slice(0, MAX_CONTEXT_CHARS) : fullText;
  const summaryBlock = t.summary ? `Resumo: ${t.summary}\n` : "";
  const keyPointsBlock = t.key_points.length
    ? `Pontos principais:\n- ${t.key_points.join("\n- ")}\n`
    : "";

  const prompt = `Você responde perguntas sobre a transcrição de uma reunião/conversa.

Responda SOMENTE com base no conteúdo abaixo. Se a informação não estiver na
transcrição, diga claramente que isso não foi mencionado. Responda em pt-BR,
de forma direta e objetiva.${truncated ? "\n(Atenção: a transcrição foi truncada; baseie-se no trecho disponível.)" : ""}

${summaryBlock}${keyPointsBlock}
<TRANSCRICAO>
${context}
</TRANSCRICAO>

Pergunta: ${question}

Saída obrigatória: APENAS JSON válido, sem markdown.
Formato exato: {"answer":"..."}`;

  try {
    const raw = await runLlmCascade(prompt, { json: true });
    if (!raw) {
      return NextResponse.json(
        { error: "Nenhum provedor de IA disponível para responder agora." },
        { status: 503 }
      );
    }
    let answer = "";
    const json = extractJsonObject(raw);
    if (json) {
      try {
        const parsed = JSON.parse(json) as { answer?: unknown };
        if (typeof parsed.answer === "string") answer = parsed.answer.trim();
      } catch {
        // fall through to raw text
      }
    }
    if (!answer) answer = raw.trim();
    return NextResponse.json({ answer });
  } catch (err) {
    console.error("[/api/transcribe/ask] failed:", err);
    return NextResponse.json({ error: "Falha ao responder a pergunta" }, { status: 500 });
  }
}
