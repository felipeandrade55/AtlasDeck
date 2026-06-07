/**
 * Re-runs the analysis pipeline on an existing transcription.
 * Useful for sessions stuck in "analyzing" (e.g. server restarted mid-run)
 * or that ended in "error".
 */
import { NextRequest, NextResponse } from "next/server";
import { getTranscription, updateTranscription } from "@/lib/transcriptions-db";
import { analyzeTranscription } from "@/lib/transcription-analyzer";
import { insertSuggestedEvent, listSuggestedEvents } from "@/lib/calendar-db";
import { upsertMemory, getSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_CONFIDENCE = 0.3;
const MEMORY_WORKSPACE = "workspace";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getTranscription(id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!t.text.trim()) {
    const updated = updateTranscription(id, { status: "analyzed" });
    return NextResponse.json({ ...updated, suggestions_created: 0 });
  }

  updateTranscription(id, { status: "analyzing" });

  let timezone = "America/Sao_Paulo";
  try {
    timezone = getSettings().home_timezone || timezone;
  } catch {}

  try {
    const analysis = await analyzeTranscription(t.text, { now: new Date(), timezone });

    // Only insert suggestions that don't already exist for this transcription
    const existing = listSuggestedEvents({ transcriptionId: id });
    const existingTitles = new Set(existing.map((e) => e.title.toLowerCase()));

    let created = 0;
    for (const ev of analysis.events) {
      if (ev.confidence < MIN_CONFIDENCE) continue;
      if (existingTitles.has(ev.title.toLowerCase())) continue;
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

    let memoryId: string | null = t.memory_id;
    try {
      const keyPointsBlock = analysis.key_points.length
        ? `\nPontos principais:\n- ${analysis.key_points.join("\n- ")}`
        : "";
      const content =
        `${analysis.summary}${keyPointsBlock}\n\n` +
        `Transcrição completa disponível (id=${id}). ` +
        `Use a ferramenta transcription_get para ler o texto integral.`;
      const mem = upsertMemory({
        workspace: MEMORY_WORKSPACE,
        agent_id: "main",
        type: "episodic",
        title: t.title,
        content: content.slice(0, 4000),
        summary: analysis.summary.slice(0, 280) || null,
        source: "import",
        tags: ["transcricao"],
        importance: 0.6,
        language: "pt-BR",
      });
      memoryId = mem.id;
    } catch (err) {
      console.warn("[/api/transcribe/reanalyze] memory save failed:", err);
    }

    const updated = updateTranscription(id, {
      status: "analyzed",
      summary: analysis.summary || null,
      key_points: analysis.key_points,
      memory_id: memoryId,
    });

    try {
      logActivity("agent", `Transcrição re-analisada: ${t.title}`, "success", {
        metadata: { source: "transcription", transcription_id: id, suggestions: created, memory_id: memoryId },
      });
    } catch {}

    return NextResponse.json({ ...updated, suggestions_created: created });
  } catch (err) {
    console.error("[/api/transcribe/reanalyze] failed:", err);
    const updated = updateTranscription(id, {
      status: "error",
      error: err instanceof Error ? err.message : "Falha na análise",
    });
    return NextResponse.json(
      { ...updated, error: "Falha ao analisar a transcrição" },
      { status: 500 }
    );
  }
}
