/**
 * Analyzes a transcription with an LLM (OpenAI → OpenClaw CLI → Ollama →
 * heuristic fallback) to produce meeting intelligence:
 *   - a short summary
 *   - key points
 *   - suggested calendar events (dates, commitments, scheduled meetings)
 *   - action items (tasks with owner + due date)
 *   - decisions made
 *   - topics/tags
 *   - open questions
 *
 * Long meetings (hours) exceed the model context, so the text is processed
 * in windows and the results merged. Relative dates ("semana que vem") are
 * resolved against the provided "now" + timezone.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { getSettings, type TranscriptionProvider } from "@/lib/memory-db";
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

export interface ActionItemDraft {
  task: string;
  owner: string | null;
  due_date: string | null;
  priority: "alta" | "media" | "baixa" | null;
  source_text: string;
  confidence: number;
}

export interface DecisionDraft {
  decision: string;
  rationale: string | null;
  owner: string | null;
}

export interface AnalysisResult {
  summary: string;
  key_points: string[];
  events: SuggestedEventDraft[];
  action_items: ActionItemDraft[];
  decisions: DecisionDraft[];
  topics: string[];
  open_questions: string[];
}

const EMPTY_ANALYSIS: AnalysisResult = {
  summary: "",
  key_points: [],
  events: [],
  action_items: [],
  decisions: [],
  topics: [],
  open_questions: [],
};

function buildPrompt(text: string, nowIso: string, tz: string): string {
  return `Você analisa a transcrição de uma reunião/conversa e extrai informações úteis.

Data/hora atual: ${nowIso} (fuso ${tz}). Use isso para resolver datas relativas
("amanhã", "semana que vem", "dia 20", "sexta") em datas ISO 8601 absolutas.

Extraia:
- summary: resumo em 2-4 frases (pt-BR).
- key_points: lista de pontos importantes (strings curtas).
- topics: lista de temas/assuntos abordados (tags curtas de 1-3 palavras, ex: "orçamento", "contratação", "marketing").
- open_questions: perguntas/dúvidas levantadas que ficaram SEM resposta na conversa (strings).
- decisions: decisões e acordos tomados ("ficou decidido que...", "vamos seguir com..."). Para cada um:
    - decision: descrição do que foi decidido
    - rationale: motivo/contexto da decisão, ou null
    - owner: responsável por executar/garantir, ou null
- action_items: tarefas e ações a executar ("fulano vai fazer X", "preciso enviar Y"). Para cada um:
    - task: descrição curta da tarefa
    - owner: responsável (nome mencionado), ou null
    - due_date: prazo em ISO 8601 com fuso, ou null se não houver
    - priority: "alta", "media" ou "baixa" (estime pela urgência), ou null
    - source_text: o trecho literal da transcrição que originou isto
    - confidence: 0.0 a 1.0 (quão certo você está de que é uma tarefa real)
- events: compromissos, reuniões agendadas e combinações com data ("fica combinado que
  no dia X farei Y"). Para cada um:
    - title: descrição curta do compromisso
    - start_at: início em ISO 8601 com fuso, ou null se não der pra determinar
    - end_at: fim em ISO 8601, ou null (se não houver, assuma 1h após start quando start existir)
    - location: local/link se mencionado, senão null
    - source_text: o trecho literal da transcrição que originou isto
    - confidence: 0.0 a 1.0 (quão certo você está de que é um compromisso real com data)

Regras:
- NÃO invente nada. Só inclua o que está claramente na transcrição.
- Distinção: events têm data/hora agendada; action_items são tarefas a fazer (podem ou não ter prazo).
- Se uma categoria estiver vazia, retorne [] para ela.
- Saída obrigatória: APENAS JSON válido, sem markdown.

Formato exato:
{"summary":"...","key_points":["..."],"topics":["..."],"open_questions":["..."],"decisions":[{"decision":"...","rationale":null,"owner":null}],"action_items":[{"task":"...","owner":null,"due_date":null,"priority":"media","source_text":"...","confidence":0.8}],"events":[{"title":"...","start_at":"2026-06-20T14:00:00-03:00","end_at":null,"location":null,"source_text":"...","confidence":0.8}]}

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

async function runOpenAI(prompt: string, json = true): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY || null;
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 3000,
        temperature: 0.2,
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
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
    return await ollamaGenerateJson(model, prompt, { temperature: 0.2, maxTokens: 2500 });
  } catch {
    return null;
  }
}

/**
 * Runs the LLM provider cascade (OpenAI → OpenClaw → Ollama) for an arbitrary
 * prompt and returns the raw text of the first provider that responds, or null
 * if all fail. Reused by the Q&A endpoint. `opts.json` controls whether OpenAI
 * is asked for strict JSON output (Ollama always uses JSON mode).
 */
export async function runLlmCascade(
  prompt: string,
  opts: { json?: boolean } = {}
): Promise<string | null> {
  const json = opts.json ?? true;
  const oa = await runOpenAI(prompt, json);
  if (oa) return oa;
  const oc = await runOpenClaw(prompt);
  if (oc) return oc;
  const ol = await runOllama(prompt);
  if (ol) return ol;
  return null;
}

function parseAnalysis(raw: string): AnalysisResult | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points.map(String).slice(0, 30) : [],
      events: Array.isArray(parsed.events)
        ? (parsed.events.map(sanitizeEvent).filter(Boolean) as SuggestedEventDraft[])
        : [],
      action_items: Array.isArray(parsed.action_items)
        ? (parsed.action_items.map(sanitizeActionItem).filter(Boolean) as ActionItemDraft[])
        : [],
      decisions: Array.isArray(parsed.decisions)
        ? (parsed.decisions.map(sanitizeDecision).filter(Boolean) as DecisionDraft[])
        : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(String).slice(0, 20) : [],
      open_questions: Array.isArray(parsed.open_questions)
        ? parsed.open_questions.map(String).slice(0, 20)
        : [],
    };
  } catch {
    return null;
  }
}

function sanitizeActionItem(raw: unknown): ActionItemDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const task = String(a.task ?? "").trim();
  if (!task) return null;
  const due = a.due_date ? String(a.due_date) : null;
  const conf = Number(a.confidence);
  const prioRaw = String(a.priority ?? "").toLowerCase().trim();
  const priority: ActionItemDraft["priority"] =
    prioRaw === "alta" || prioRaw === "media" || prioRaw === "baixa" ? prioRaw : null;
  return {
    task: task.slice(0, 300),
    owner: a.owner ? String(a.owner).slice(0, 120) : null,
    due_date: due && !Number.isNaN(new Date(due).getTime()) ? due : null,
    priority,
    source_text: String(a.source_text ?? "").slice(0, 500),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
  };
}

function sanitizeDecision(raw: unknown): DecisionDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const decision = String(d.decision ?? "").trim();
  if (!decision) return null;
  return {
    decision: decision.slice(0, 400),
    rationale: d.rationale ? String(d.rationale).slice(0, 400) : null,
    owner: d.owner ? String(d.owner).slice(0, 120) : null,
  };
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

async function analyzeWindow(
  text: string,
  nowIso: string,
  tz: string,
  provider: TranscriptionProvider
): Promise<AnalysisResult | null> {
  const prompt = buildPrompt(text, nowIso, tz);

  // "ollama": local-only. Never silently fall back to a paid API when the user
  // explicitly chose the local model.
  if (provider === "ollama") {
    const ol = await runOllama(prompt);
    if (ol) {
      const parsed = parseAnalysis(ol);
      if (parsed) return parsed;
    }
    return null;
  }

  // "openai" (default): OpenAI first, then OpenClaw and Ollama as resilience
  // fallbacks if the API is unavailable.
  const oa = await runOpenAI(prompt);
  if (oa) {
    const parsed = parseAnalysis(oa);
    if (parsed) return parsed;
  }
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

function dedupeActionItems(items: ActionItemDraft[]): ActionItemDraft[] {
  const seen = new Set<string>();
  const out: ActionItemDraft[] = [];
  for (const a of items) {
    const key = `${a.task.toLowerCase()}|${a.due_date ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function dedupeDecisions(decisions: DecisionDraft[]): DecisionDraft[] {
  const seen = new Set<string>();
  const out: DecisionDraft[] = [];
  for (const d of decisions) {
    const key = d.decision.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Heuristic fallback: naive summary from the first sentences, nothing else. */
function heuristic(text: string): AnalysisResult {
  const clean = text.replace(/\s+/g, " ").trim();
  return {
    ...EMPTY_ANALYSIS,
    summary: clean.slice(0, 280) + (clean.length > 280 ? "…" : ""),
  };
}

export async function analyzeTranscription(
  text: string,
  opts: { now?: Date; timezone?: string; provider?: TranscriptionProvider } = {}
): Promise<AnalysisResult> {
  const clean = (text || "").trim();
  if (!clean) return { ...EMPTY_ANALYSIS };

  const now = opts.now ?? new Date();
  const tz = opts.timezone || "America/Sao_Paulo";
  const nowIso = now.toISOString();

  // Provider comes from settings unless explicitly overridden by the caller.
  let provider: TranscriptionProvider = opts.provider ?? "openai";
  if (!opts.provider) {
    try {
      provider = getSettings().transcription_provider;
    } catch {}
  }

  const parts = windows(clean);
  const results: AnalysisResult[] = [];
  for (const part of parts) {
    const r = await analyzeWindow(part, nowIso, tz, provider);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    return heuristic(clean);
  }

  const summary =
    results.length === 1
      ? results[0].summary
      : results.map((r) => r.summary).filter(Boolean).join(" ").slice(0, 600);

  return {
    summary: summary || heuristic(clean).summary,
    key_points: dedupeStrings(results.flatMap((r) => r.key_points)).slice(0, 30),
    events: dedupeEvents(results.flatMap((r) => r.events)),
    action_items: dedupeActionItems(results.flatMap((r) => r.action_items)),
    decisions: dedupeDecisions(results.flatMap((r) => r.decisions)),
    topics: dedupeStrings(results.flatMap((r) => r.topics)).slice(0, 20),
    open_questions: dedupeStrings(results.flatMap((r) => r.open_questions)).slice(0, 20),
  };
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
