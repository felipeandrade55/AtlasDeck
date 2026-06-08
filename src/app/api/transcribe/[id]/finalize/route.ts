/**
 * Finalizes a transcription session: analyzes the full text (summary + key
 * points + suggested events), pushes the suggestions into the approval queue,
 * saves a memory so Jarvis recalls it, and marks the session analyzed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTranscription, updateTranscription } from "@/lib/transcriptions-db";
import { analyzeTranscription } from "@/lib/transcription-analyzer";
import { insertSuggestedEvent } from "@/lib/calendar-db";
import { insertSuggestedTask } from "@/lib/reminders-db";
import { upsertMemory, getSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_CONFIDENCE = 0.3;
const MEMORY_WORKSPACE = "workspace"; // agent "main" → "workspace" (matches MCP)

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const durationMs = typeof body.duration_ms === "number" ? body.duration_ms : null;

  // Empty transcript → just close it.
  if (!t.text.trim()) {
    const updated = updateTranscription(id, { status: "analyzed", duration_ms: durationMs });
    return NextResponse.json({ ...updated, suggestions_created: 0 });
  }

  updateTranscription(id, { status: "analyzing", duration_ms: durationMs });

  let timezone = "America/Sao_Paulo";
  try {
    timezone = getSettings().home_timezone || timezone;
  } catch {}

  try {
    const analysis = await analyzeTranscription(t.text, { now: new Date(), timezone });

    let created = 0;
    for (const ev of analysis.events) {
      if (ev.confidence < MIN_CONFIDENCE) continue;
      insertSuggestedEvent({
        transcription_id: id,
        title: ev.title,
        description: ev.source_text || null,
        start_at: ev.start_at,
        end_at: ev.end_at,
        location: ev.location,
        source_text: ev.source_text || null,
        confidence: ev.confidence,
      });
      created += 1;
    }

    let tasksCreated = 0;
    for (const ai of analysis.action_items) {
      if (ai.confidence < MIN_CONFIDENCE) continue;
      insertSuggestedTask({
        transcription_id: id,
        task: ai.task,
        owner: ai.owner,
        due_date: ai.due_date,
        priority: ai.priority,
        source_text: ai.source_text || null,
        confidence: ai.confidence,
      });
      tasksCreated += 1;
    }

    // Save a memory so the agent remembers this conversation happened and can
    // recall the gist. The full text lives in the transcriptions DB (exposed
    // to the agent via the MCP transcription_* tools).
    let memoryId: string | null = null;
    try {
      const keyPointsBlock = analysis.key_points.length
        ? `\nPontos principais:\n- ${analysis.key_points.join("\n- ")}`
        : "";
      const decisionsBlock = analysis.decisions.length
        ? `\nDecisões:\n- ${analysis.decisions.map((d) => d.decision).join("\n- ")}`
        : "";
      const content =
        `${analysis.summary}${keyPointsBlock}${decisionsBlock}\n\n` +
        `Transcrição completa disponível (id=${id}). ` +
        `Use a ferramenta transcription_get para ler o texto integral.`;
      const hasDecisions = analysis.decisions.length > 0;
      const tags = ["transcricao", ...(hasDecisions ? ["reuniao", "decisao"] : [])];
      const mem = upsertMemory({
        workspace: MEMORY_WORKSPACE,
        agent_id: "main",
        type: "episodic",
        title: t.title,
        content: content.slice(0, 4000),
        summary: analysis.summary.slice(0, 280) || null,
        source: "import",
        tags,
        importance: hasDecisions ? 0.8 : 0.65,
        language: "pt-BR",
      });
      memoryId = mem.id;
    } catch (err) {
      console.warn("[/api/transcribe/finalize] memory save failed:", err);
    }

    const updated = updateTranscription(id, {
      status: "analyzed",
      summary: analysis.summary || null,
      key_points: analysis.key_points,
      decisions: analysis.decisions,
      topics: analysis.topics,
      open_questions: analysis.open_questions,
      memory_id: memoryId,
      duration_ms: durationMs,
    });

    try {
      logActivity("agent", `Transcrição analisada: ${t.title}`, "success", {
        metadata: {
          source: "transcription",
          transcription_id: id,
          suggestions: created,
          tasks: tasksCreated,
          memory_id: memoryId,
        },
      });
    } catch {}

    return NextResponse.json({ ...updated, suggestions_created: created, tasks_created: tasksCreated });
  } catch (err) {
    console.error("[/api/transcribe/finalize] failed:", err);
    const updated = updateTranscription(id, {
      status: "error",
      error: err instanceof Error ? err.message : "Falha na análise",
      duration_ms: durationMs,
    });
    return NextResponse.json(
      { ...updated, error: "Falha ao analisar a transcrição" },
      { status: 500 }
    );
  }
}
