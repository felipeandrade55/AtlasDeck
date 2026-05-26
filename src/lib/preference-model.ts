/**
 * Preference extraction pipeline. Two signal sources:
 *
 *   1. Explicit — task.user_approved + task.user_feedback (thumbs up/down +
 *      optional text).
 *   2. Implicit — sentiment hints from the user_feedback text or downstream
 *      chat replies. For v1 we ship a lightweight keyword classifier; the
 *      Learner Agent (Fase 4) replaces this with an LLM-driven sentiment
 *      extractor once cron infrastructure is ready.
 *
 * Patterns are stored via learnings-db.ts. The orchestrator-injector reads
 * the top-N for each agent and slots them into the workspace prompt so the
 * specialist actually behaves differently next time.
 */
import { recordLearning, listLearnings, type Learning } from "@/lib/learnings-db";
import { getTaskById, type Task } from "@/lib/tasks-db";

const POSITIVE_HINTS = [
  "perfeito", "ficou ótimo", "ficou otimo", "muito bom", "exatamente",
  "isso aí", "isso ai", "show", "top", "amei", "gostei",
  "como eu queria", "exatamente isso",
];
const NEGATIVE_HINTS = [
  "não era isso", "nao era isso", "esqueceu", "faltou", "ruim",
  "não é isso", "nao e isso", "errado", "refaz", "refazer",
  "tenta de novo", "pior", "não gostei", "nao gostei",
];

function classifySentiment(text: string): "positive" | "negative" | "neutral" {
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const k of POSITIVE_HINTS) if (lower.includes(k)) pos++;
  for (const k of NEGATIVE_HINTS) if (lower.includes(k)) neg++;
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

/**
 * Distills a freeform feedback string into one or more "pattern" sentences
 * the model can later use. v1: heuristic — anchors on negation phrases and
 * lifts the rest as the rule ("não usar X" → "evitar X"). Good enough to
 * seed; the Learner Agent will refine downstream.
 */
function distillPatterns(feedback: string): string[] {
  const out: string[] = [];
  const lower = feedback.toLowerCase().trim();
  if (!lower) return out;

  const negationMatch = lower.match(/(?:não|nao)\s+(?:gosto|gostei|quero|gosta|gostou)\s+(?:de\s+|que\s+)?(.+)/);
  if (negationMatch) {
    out.push(`evitar: ${negationMatch[1].trim().slice(0, 120)}`);
  }
  const preferMatch = lower.match(/(?:prefiro|prefere|gosto|amo|adoro)\s+(?:de\s+|que\s+)?(.+)/);
  if (preferMatch) {
    out.push(`preferir: ${preferMatch[1].trim().slice(0, 120)}`);
  }

  if (out.length === 0) {
    // Fallback: keep raw feedback as a single pattern up to 160 chars.
    out.push(feedback.trim().slice(0, 160));
  }
  return out;
}

export interface IngestResult {
  task_id: string;
  agent_id: string | null;
  signal: "approval" | "rejection" | "neutral";
  learnings_written: number;
}

/**
 * Ingests a single task's approval/feedback into the preference store.
 * Idempotent — re-running on the same task only bumps confidence on
 * existing matching learnings (see learnings-db.recordLearning).
 */
export function ingestTaskFeedback(task: Task): IngestResult {
  if (task.user_approved === null || task.user_approved === undefined) {
    return { task_id: task.id, agent_id: task.assigned_to, signal: "neutral", learnings_written: 0 };
  }

  const evidence = `task:${task.id}`;
  const written: Learning[] = [];

  if (task.user_approved === true) {
    // Approval is a weak positive signal on its own — the real value comes
    // from feedback text. Still, register a generic "what this specialist
    // produced today was OK" so we can detect agents that consistently
    // satisfy the user without further input.
    written.push(
      recordLearning({
        agent_id: task.assigned_to,
        pattern: `entregas no estilo recente foram aprovadas`,
        evidence,
        source: "approval",
        confidence: 0.15,
      }),
    );
    if (task.user_feedback) {
      for (const p of distillPatterns(task.user_feedback)) {
        written.push(
          recordLearning({
            agent_id: task.assigned_to,
            pattern: `usuário reforçou: ${p}`,
            evidence,
            source: "feedback_text",
            confidence: 0.25,
          }),
        );
      }
    }
    return {
      task_id: task.id,
      agent_id: task.assigned_to,
      signal: "approval",
      learnings_written: written.length,
    };
  }

  // user_approved === false → rejection
  written.push(
    recordLearning({
      agent_id: task.assigned_to,
      pattern: `entregas recentes foram rejeitadas — revisar estilo`,
      evidence,
      source: "rejection",
      confidence: 0.25,
    }),
  );
  if (task.user_feedback) {
    for (const p of distillPatterns(task.user_feedback)) {
      written.push(
        recordLearning({
          agent_id: task.assigned_to,
          pattern: `aprendizado de rejeição: ${p}`,
          evidence,
          source: "feedback_text",
          confidence: 0.35,
        }),
      );
    }
    const sentiment = classifySentiment(task.user_feedback);
    if (sentiment === "negative") {
      written.push(
        recordLearning({
          agent_id: task.assigned_to,
          pattern: `usuário expressou frustração forte após entrega — recalibrar`,
          evidence,
          source: "implicit_sentiment",
          confidence: 0.15,
        }),
      );
    }
  }
  return {
    task_id: task.id,
    agent_id: task.assigned_to,
    signal: "rejection",
    learnings_written: written.length,
  };
}

export function ingestTaskFeedbackById(taskId: string): IngestResult | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  return ingestTaskFeedback(task);
}

/**
 * Returns the top-N learnings for an agent (own + global), formatted as a
 * compact bullet list ready to slot into a prompt. Caller owns the framing
 * around it ("based on past feedback, you should…").
 */
export function getPreferencesForPrompt(agentId: string, limit = 8): string {
  const own = listLearnings({ agent_id: agentId, min_confidence: 0.25, limit });
  if (own.length === 0) return "";
  return own
    .slice(0, limit)
    .map((l) => `- ${l.pattern} (conf ${l.confidence.toFixed(2)})`)
    .join("\n");
}
