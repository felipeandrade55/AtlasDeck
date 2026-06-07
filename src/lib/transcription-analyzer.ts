/**
 * Analyzes a transcription with an LLM (OpenClaw CLI → Ollama → heuristic
 * fallback, same strategy as memory-extractor.ts) to produce:
 *   - a short summary
 *   - key points
 *   - suggested calendar events (dates, commitments, scheduled meetings)
 *
 * Long meetings (hours) exceed the model context, so the text is processed
 * in windows and the results merged. Relative dates ("semana que vem") are
 * resolved against the provided "now" + timezone.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { getSettings } from "@/lib/memory-db";
import { generateJson as ollamaGenerateJson } from "@/lib/ollama-client";

const execFileAsync = promisify(execFile);

const OPENCLAW_TIMEOUT_MS = 90_000;
const OPENCLAW_MAX_BUFFER = 8 * 1024 * 1024;
const WINDOW_CHARS = 6000;
const MAX_WINDOWS = 12; // safety cap for extremely long meetings

export interface SuggestedEventDraft {
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  source_text: string;
  confidence: number;
}

export interface AnalysisResult {
  summary: string;
  key_points: string[];
  events: SuggestedEventDraft[];
}

function buildPrompt(text: string, nowIso: string, tz: string): string {
  return `Você analisa a transcrição de uma reunião/conversa e extrai informações úteis.

Data/hora atual: ${nowIso} (fuso ${tz}). Use isso para resolver datas relativas
("amanhã", "semana que vem", "dia 20", "sexta") em datas ISO 8601 absolutas.

Extraia:
- summary: resumo em 2-4 frases (pt-BR).
- key_points: lista de pontos importantes/decisões (strings curtas).
- events: compromissos, reuniões agendadas e combinações com data ("fica combinado que
  no dia X farei Y"). Para cada um:
    - title: descrição curta do compromisso
    - start_at: início em ISO 8601 com fuso, ou null se não der pra determinar
    - end_at: fim em ISO 8601, ou null (se não houver, assuma 1h após start quando start existir)
    - location: local/link se mencionado, senão null
    - source_text: o trecho literal da transcrição que originou isto
    - confidence: 0.0 a 1.0 (quão certo você está de que é um compromisso real com data)

Regras:
- NÃO invente compromissos. Só inclua o que está claramente na transcrição.
- Se nada for um compromisso, retorne events: [].
- Saída obrigatória: APENAS JSON válido, sem markdown.

Formato exato:
{"summary":"...","key_points":["..."],"events":[{"title":"...","start_at":"2026-06-20T14:00:00-03:00","end_at":null,"location":null,"source_text":"...","confidence":0.8}]}

<TRANSCRICAO>
${text}
</TRANSCRICAO>`;
}

function windows(text: string): string[] {
  const clean = text.trim();
  if (clean.length <= WINDOW_CHARS) return [clean];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length && out.length < MAX_WINDOWS) {
    out.push(clean.slice(i, i + WINDOW_CHARS));
    i += WINDOW_CHARS;
  }
  return out;
}

function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function runOpenClaw(prompt: string): Promise<string | null> {
  try {
    const config = readOpenClawConfig();
    const { stdout } = await execFileAsync(
      config.openclawBin,
      ["ask", "--json", "--prompt", prompt],
      {
        timeout: OPENCLAW_TIMEOUT_MS,
        maxBuffer: OPENCLAW_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DIR: config.openclawDir,
          OPENCLAW_WORKSPACE: config.openclawWorkspace,
        },
      }
    );
    return String(stdout);
  } catch {
    return null;
  }
}

async function runOllama(prompt: string): Promise<string | null> {
  try {
    const model = getSettings().ollama_model || "qwen2.5:7b";
    return await ollamaGenerateJson(model, prompt, { temperature: 0.2, maxTokens: 1500 });
  } catch {
    return null;
  }
}

function parseAnalysis(raw: string): AnalysisResult | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<AnalysisResult>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points.map(String).slice(0, 30) : [],
      events: Array.isArray(parsed.events) ? parsed.events.map(sanitizeEvent).filter(Boolean) as SuggestedEventDraft[] : [],
    };
  } catch {
    return null;
  }
}

function sanitizeEvent(raw: unknown): SuggestedEventDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const title = String(e.title ?? "").trim();
  if (!title) return null;
  const start = e.start_at ? String(e.start_at) : null;
  let end = e.end_at ? String(e.end_at) : null;
  if (start && !end) {
    const d = new Date(start);
    if (!Number.isNaN(d.getTime())) end = new Date(d.getTime() + 60 * 60 * 1000).toISOString();
  }
  const conf = Number(e.confidence);
  return {
    title: title.slice(0, 200),
    start_at: start && !Number.isNaN(new Date(start).getTime()) ? start : null,
    end_at: end && !Number.isNaN(new Date(end).getTime()) ? end : null,
    location: e.location ? String(e.location).slice(0, 300) : null,
    source_text: String(e.source_text ?? "").slice(0, 500),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
  };
}

async function analyzeWindow(text: string, nowIso: string, tz: string): Promise<AnalysisResult | null> {
  const prompt = buildPrompt(text, nowIso, tz);
  const oc = await runOpenClaw(prompt);
  if (oc) {
    const parsed = parseAnalysis(oc);
    if (parsed) return parsed;
  }
  const ol = await runOllama(prompt);
  if (ol) {
    const parsed = parseAnalysis(ol);
    if (parsed) return parsed;
  }
  return null;
}

function dedupeEvents(events: SuggestedEventDraft[]): SuggestedEventDraft[] {
  const seen = new Set<string>();
  const out: SuggestedEventDraft[] = [];
  for (const e of events) {
    const key = `${e.title.toLowerCase()}|${e.start_at ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Heuristic fallback: no events, naive summary from the first sentences. */
function heuristic(text: string): AnalysisResult {
  const clean = text.replace(/\s+/g, " ").trim();
  return {
    summary: clean.slice(0, 280) + (clean.length > 280 ? "…" : ""),
    key_points: [],
    events: [],
  };
}

export async function analyzeTranscription(
  text: string,
  opts: { now?: Date; timezone?: string } = {}
): Promise<AnalysisResult> {
  const clean = (text || "").trim();
  if (!clean) return { summary: "", key_points: [], events: [] };

  const now = opts.now ?? new Date();
  const tz = opts.timezone || "America/Sao_Paulo";
  const nowIso = now.toISOString();

  const parts = windows(clean);
  const results: AnalysisResult[] = [];
  for (const part of parts) {
    const r = await analyzeWindow(part, nowIso, tz);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    return heuristic(clean);
  }

  const summary =
    results.length === 1
      ? results[0].summary
      : results.map((r) => r.summary).filter(Boolean).join(" ").slice(0, 600);
  const keyPoints = dedupeStrings(results.flatMap((r) => r.key_points)).slice(0, 30);
  const events = dedupeEvents(results.flatMap((r) => r.events));

  return { summary: summary || heuristic(clean).summary, key_points: keyPoints, events };
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}
