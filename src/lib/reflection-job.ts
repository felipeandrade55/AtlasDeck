/**
 * Nightly reflection — the "consolidation" step that turns a pile of
 * extracted facts into a model of the owner.
 *
 *  1. Dedupe (deterministic): near-identical memories of the same type are
 *     merged — the keeper absorbs tags/importance, the other is archived
 *     and linked `duplicate_of`.
 *  2. Profile (1 LLM call): identity + preferences + confident learnings +
 *     main clients → a short imperative profile written to a managed block
 *     in the main agent's USER.md ("Perfil aprendido pelo AtlasDeck").
 *  3. Procedures (same LLM call): approved multi-step tasks / repeated
 *     deliverables → `procedural` memories on 14-day probation
 *     (source "reflection"). Used ones are promoted by the hourly
 *     housekeep (reviewProbationExpired); unused ones are archived.
 *  4. Skills (opt-in, ATLAS_AUTO_SKILLS=1): promoted procedures become
 *     `<workspace>/skills/atlas-<slug>/SKILL.md`.
 *
 * Bounded: one LLM call per run, only when the agent is idle.
 */
import fs from "fs";
import path from "path";
import {
  createLink,
  finishJob,
  getSettingValue,
  listMemories,
  searchSimilar,
  setSettingValue,
  startJob,
  updateMemory,
  getMemoryEmbedding,
  type MemoryRow,
} from "@/lib/memory-db";
import { addMemory, ownerDisplayName } from "@/lib/memory-service";
import { currentEmbeddingModelTag, similarityThresholds } from "@/lib/embedding-config";
import { listLearnings } from "@/lib/learnings-db";
import { describeBrandKit, getBrandKit, listEntities, setDeliverableOutcomeByTask } from "@/lib/entity-db";
import { listTasks } from "@/lib/tasks-db";
import { runOneShotJson, isOneShotAvailable } from "@/lib/llm-oneshot";
import { isAgentBusy } from "@/lib/agent-activity";
import { updateManagedBlock } from "@/lib/managed-markdown";
import { getAgentWorkspacePath, getOpenClawWorkspace } from "@/lib/openclaw-config";

const WORKSPACE = "workspace";
const LAST_RUN_KEY = "reflection_last_run";
export const PROFILE_BEGIN = "<!-- BEGIN ATLASDECK PROFILE — gerado pelo AtlasDeck; edite fora deste bloco -->";
export const PROFILE_END = "<!-- END ATLASDECK PROFILE -->";
const PROFILE_MAX_CHARS = 2_000;

function clip(text: string | null | undefined, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ─── 1. dedupe ─────────────────────────────────────────────────────────

export function mergeDuplicateMemories(limit = 400): { merged: number; scanned: number } {
  const model = currentEmbeddingModelTag();
  const threshold = similarityThresholds(model).duplicate;
  const { memories } = listMemories({ workspace: WORKSPACE, archived: false, limit: 200, sort: "updated" });
  const recent = memories.slice(0, limit);
  const gone = new Set<string>();
  let merged = 0;
  for (const m of recent) {
    if (gone.has(m.id) || m.embedding_model !== model) continue;
    const vec = getMemoryEmbedding(m.id);
    if (!vec) continue;
    const [dup] = searchSimilar(vec, {
      workspace: WORKSPACE,
      type: m.type,
      k: 1,
      minScore: threshold,
      excludeIds: [m.id, ...gone],
      model,
    });
    if (!dup) continue;
    const other = dup.memory;
    // Keeper: pinned > more important > more recently updated.
    const rank = (x: MemoryRow) => (x.pinned ? 10 : 0) + x.importance + (Date.parse(x.updated_at) || 0) / 1e15;
    const [keep, drop] = rank(m) >= rank(other) ? [m, other] : [other, m];
    updateMemory(keep.id, {
      importance: Math.max(keep.importance, drop.importance),
      tags: [...new Set([...keep.tags, ...drop.tags])].slice(0, 12),
    });
    updateMemory(drop.id, { archived: true });
    createLink(drop.id, keep.id, "duplicate_of", "cosine", dup.score);
    gone.add(drop.id);
    merged++;
  }
  return { merged, scanned: recent.length };
}

// ─── deliverable outcomes from task verdicts ───────────────────────────

export function syncDeliverableOutcomes(): number {
  let n = 0;
  for (const t of listTasks({ status: ["done", "review"], limit: 200, sort: "newest" })) {
    if (t.user_approved === null || t.user_approved === undefined) continue;
    n += setDeliverableOutcomeByTask(t.id, t.user_approved ? "aprovado" : "rejeitado", t.user_feedback ?? null);
  }
  return n;
}

// ─── 2+3. profile + procedures ─────────────────────────────────────────

interface ReflectionOutput {
  profile_md: string;
  procedures?: Array<{ title?: string; when?: string; steps?: string[]; pitfalls?: string; verify?: string }>;
}

function isReflectionOutput(v: unknown): v is ReflectionOutput {
  return Boolean(v) && typeof v === "object" && typeof (v as { profile_md?: unknown }).profile_md === "string";
}

function buildReflectionPrompt(owner: string): string | null {
  const all = listMemories({ workspace: WORKSPACE, archived: false, limit: 200, sort: "importance" }).memories;
  const identity = all.filter((m) => m.type === "identity").slice(0, 10);
  const prefs = all
    .filter((m) => m.type === "semantic" && (m.tags.some((t) => /pref/i.test(t)) || /prefer|sempre|nunca|gosta/i.test(m.title)))
    .slice(0, 15);
  const learned = listLearnings({ agent_id: null, min_confidence: 0.4, limit: 15 }).filter(
    (l) => l.source === "conversation" || l.source === "correction" || l.source === "feedback_text" || l.source === "manual",
  );
  const clients = listEntities({ workspace: WORKSPACE, type: ["client", "brand"], limit: 8 });
  const procedural = all.filter((m) => m.type === "procedural").slice(0, 10);
  const approved = listTasks({ status: "done", limit: 60, sort: "newest" })
    .filter((t) => t.user_approved === true)
    .slice(0, 8);

  if (identity.length + prefs.length + learned.length === 0 && approved.length === 0) return null;

  const section = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.join("\n")}\n` : "");
  return `Você consolida o que um assistente pessoal aprendeu sobre ${owner}.

${section("IDENTIDADE:", identity.map((m) => `- ${clip(m.content, 220)}`))}
${section("PREFERÊNCIAS REGISTRADAS:", prefs.map((m) => `- ${clip(m.content, 200)}`))}
${section("PREFERÊNCIAS APRENDIDAS (confiança):", learned.map((l) => `- ${clip(l.pattern, 180)} (${l.confidence.toFixed(2)})`))}
${section("CLIENTES PRINCIPAIS:", clients.map((e) => `- ${e.name}${e.summary ? `: ${clip(e.summary, 120)}` : ""}${getBrandKit(e) ? ` | identidade: ${clip(describeBrandKit(getBrandKit(e)!), 120)}` : ""}`))}
${section("PROCEDIMENTOS JÁ CONHECIDOS (não repita):", procedural.map((m) => `- ${m.title}`))}
${section("TAREFAS APROVADAS RECENTEMENTE:", approved.map((t) => `- ${clip(t.title || t.prompt, 100)} → ${clip(t.result, 300)}${t.user_feedback ? ` | feedback: ${clip(t.user_feedback, 120)}` : ""}`))}

TAREFA
1. profile_md: perfil em markdown, no máximo ${PROFILE_MAX_CHARS} caracteres, escrito como DIRETIVAS para o assistente ("Responda curto e sem emoji.", "${owner} é dono de uma agência…"). Seções curtas: "Quem é", "Como prefere que você trabalhe", "Clientes e contexto". Só o que está sustentado acima; em contradições, fique com a informação de maior confiança/mais recente. Sem inventar.
2. procedures: 0 a 3 procedimentos NOVOS e reutilizáveis que as tarefas aprovadas revelam (ex.: "Como montar landing page de cliente"). Só se houver padrão claro.

Responda SOMENTE com JSON:
{"profile_md":"...","procedures":[{"title":"...","when":"quando usar","steps":["..."],"pitfalls":"...","verify":"como conferir"}]}`;
}

function userMdPath(): string | null {
  const ws = getAgentWorkspacePath("main") ?? getOpenClawWorkspace();
  return ws ? path.join(ws, "USER.md") : null;
}

async function writeProfile(profile: string): Promise<boolean> {
  const file = userMdPath();
  if (!file) return false;
  const text = profile.trim();
  const body = text.length > PROFILE_MAX_CHARS ? `${text.slice(0, PROFILE_MAX_CHARS - 1)}…` : text;
  const res = await updateManagedBlock(
    file,
    PROFILE_BEGIN,
    PROFILE_END,
    () =>
      `${PROFILE_BEGIN}\n## Perfil aprendido pelo AtlasDeck\n_Atualizado em ${new Date().toISOString().slice(0, 10)} — corrija pelo painel (Memória → Aprendizado)._\n\n${body.trim()}\n${PROFILE_END}`,
    { initialContent: "# USER\n" },
  );
  return res.changed;
}

export function readProfile(): string | null {
  const file = userMdPath();
  if (!file || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const b = raw.indexOf(PROFILE_BEGIN);
  const e = raw.indexOf(PROFILE_END);
  return b !== -1 && e > b ? raw.slice(b + PROFILE_BEGIN.length, e).trim() : null;
}

async function saveProcedures(list: NonNullable<ReflectionOutput["procedures"]>): Promise<number> {
  let n = 0;
  const probation = new Date(Date.now() + 14 * 86_400_000).toISOString();
  for (const p of list.slice(0, 3)) {
    const title = clip(p.title, 120);
    const steps = (p.steps ?? []).map((s) => clip(s, 200)).filter(Boolean);
    if (!title || steps.length < 2) continue;
    const content = [
      p.when ? `Quando usar: ${clip(p.when, 200)}` : null,
      `Passos:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      p.pitfalls ? `Cuidados: ${clip(p.pitfalls, 200)}` : null,
      p.verify ? `Como conferir: ${clip(p.verify, 200)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const res = await addMemory({
      workspace: WORKSPACE,
      agent_id: "main",
      type: "procedural",
      title,
      content,
      source: "reflection",
      tags: ["procedimento", "auto"],
      importance: 0.65,
      probation_until: probation,
    });
    if (res.action === "created") n++;
  }
  return n;
}

// ─── 4. skills (opt-in) ────────────────────────────────────────────────

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** Write promoted procedures as SKILL.md files in the main workspace. */
export function exportProcedureSkills(): number {
  if (process.env.ATLAS_AUTO_SKILLS !== "1") return 0;
  const ws = getAgentWorkspacePath("main") ?? getOpenClawWorkspace();
  if (!ws) return 0;
  const procedures = listMemories({ workspace: WORKSPACE, archived: false, type: "procedural", limit: 50 }).memories.filter(
    (m) => m.source === "reflection" && !m.probation_until,
  );
  let n = 0;
  for (const m of procedures) {
    const dir = path.join(ws, "skills", `atlas-${slug(m.title)}`);
    const file = path.join(dir, "SKILL.md");
    const body = `---\nname: atlas-${slug(m.title)}\ndescription: ${m.title.replace(/\n/g, " ")} (procedimento aprendido pelo AtlasDeck)\n---\n\n# ${m.title}\n\n${m.content}\n`;
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === body) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, "utf-8");
      n++;
    } catch (err) {
      console.warn("[reflection] skill export failed:", err instanceof Error ? err.message : err);
    }
  }
  return n;
}

// ─── orchestration ─────────────────────────────────────────────────────

export interface ReflectionResult {
  ran: boolean;
  reason?: string;
  merged: number;
  profileUpdated: boolean;
  procedures: number;
  skills: number;
  outcomes: number;
}

export async function runReflection(opts: { force?: boolean } = {}): Promise<ReflectionResult> {
  const result: ReflectionResult = { ran: false, merged: 0, profileUpdated: false, procedures: 0, skills: 0, outcomes: 0 };
  const jobId = startJob("reflect");
  try {
    result.outcomes = syncDeliverableOutcomes();
    result.merged = mergeDuplicateMemories().merged;

    if (!isOneShotAvailable()) {
      result.reason = "LLM indisponível (circuit breaker)";
    } else if (!opts.force && (await isAgentBusy(5 * 60_000))) {
      result.reason = "agente ocupado";
    } else {
      const prompt = buildReflectionPrompt(ownerDisplayName());
      if (!prompt) {
        result.reason = "pouco material ainda";
      } else {
        const { data } = await runOneShotJson<ReflectionOutput>(prompt, {
          purpose: "reflect",
          validate: isReflectionOutput,
          timeoutMs: 180_000,
        });
        if (data.profile_md.trim().length > 40) result.profileUpdated = await writeProfile(data.profile_md);
        result.procedures = await saveProcedures(data.procedures ?? []);
        result.ran = true;
      }
    }
    result.skills = exportProcedureSkills();
    // Busy / LLM down → try again next hour instead of waiting a day.
    if (result.ran || result.reason === "pouco material ainda") {
      setSettingValue(LAST_RUN_KEY, new Date().toISOString());
    }
    finishJob(jobId, result.ran ? "ok" : "skipped", { detail: JSON.stringify(result) });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(jobId, "failed", { error: message });
    return { ...result, reason: message };
  }
}

/** Called hourly: run at night (server time) once a day, or if overdue. */
export async function maybeRunReflection(): Promise<void> {
  const last = Date.parse(getSettingValue(LAST_RUN_KEY) ?? "") || 0;
  const hoursSince = (Date.now() - last) / 3_600_000;
  const hour = new Date().getHours();
  const nightWindow = hour >= 2 && hour <= 6;
  if ((nightWindow && hoursSince >= 20) || hoursSince >= 36) {
    await runReflection();
  }
}
