/**
 * What a specialist should know before doing a delegated task.
 *
 * Before: the worker got only `task.prompt` — the orchestrator had to
 * remember to repeat the client's colors, the owner's preferences, etc.,
 * and usually didn't. Now every delegated run starts with:
 *   - the owner's standing preferences (how they like work delivered);
 *   - cards for the clients/projects named in the task, with brand kit
 *     and the last deliverable for them;
 *   - the few memories most relevant to the task.
 *
 * Bounded (chars + time) and fail-open: a broken memory layer never
 * blocks task execution.
 */
import { listMemories, type MemoryRow } from "@/lib/memory-db";
import { searchHybrid } from "@/lib/memory-service";
import {
  describeBrandKit,
  findMentionedEntities,
  getBrandKit,
  listDeliverables,
} from "@/lib/entity-db";
import { getPreferenceList } from "@/lib/preference-model";

/** The owner's knowledge lives in the main agent's workspace. */
const OWNER_WORKSPACE = "workspace";
const MAX_CHARS = 2_500;

function clip(text: string | null | undefined, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function preferenceMemories(): MemoryRow[] {
  return listMemories({
    workspace: OWNER_WORKSPACE,
    archived: false,
    type: ["semantic", "identity"],
    limit: 60,
    sort: "importance",
  }).memories.filter(
    (m) =>
      m.pinned ||
      m.tags.some((t) => /^pref|preferencia|preferência/i.test(t)) ||
      /prefer|sempre|nunca|não gosta|nao gosta/i.test(m.title),
  );
}

export async function buildDelegationContext(input: { agentId: string; prompt: string }): Promise<string> {
  const prompt = input.prompt || "";
  const parts: string[] = [];
  const used = new Set<string>();

  // 1) Standing preferences (learned + memories).
  const prefLines: string[] = [];
  for (const p of getPreferenceList(input.agentId, 5)) prefLines.push(`- ${clip(p, 200)}`);
  for (const m of preferenceMemories().slice(0, 5)) {
    used.add(m.id);
    prefLines.push(`- ${clip(m.content, 200)}`);
  }
  if (prefLines.length) parts.push(`Preferências do dono:\n${[...new Set(prefLines)].slice(0, 8).join("\n")}`);

  // 2) Clients / projects named in the task.
  const entities = findMentionedEntities(OWNER_WORKSPACE, prompt, ["client", "brand", "project", "organization"]).slice(0, 3);
  for (const e of entities) {
    const lines = [`**${e.name}** (${e.type})${e.summary ? ` — ${clip(e.summary, 160)}` : ""}`];
    const kit = getBrandKit(e);
    if (kit) lines.push(`  identidade visual: ${describeBrandKit(kit)}`);
    const last = listDeliverables({ workspace: OWNER_WORKSPACE, clientEntityId: e.id, limit: 1 })[0];
    if (last) {
      lines.push(
        `  último trabalho: ${last.kind} "${clip(last.title, 60)}"${last.approach ? ` — ${clip(last.approach, 140)}` : ""}${last.artifact_url || last.artifact_path ? ` (${last.artifact_url || last.artifact_path})` : ""}`,
      );
    }
    parts.push(lines.join("\n"));
  }

  // 3) Memories relevant to this task.
  const hits = await searchHybrid(prompt.slice(0, 1500), { workspace: OWNER_WORKSPACE, k: 5, excludeIds: [...used] });
  if (hits.length) {
    parts.push(`Fatos relevantes:\n${hits.map((h) => `- ${clip(h.memory.content, 220)}`).join("\n")}`);
  }

  if (!parts.length) return "";
  let body = parts.join("\n\n");
  if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS - 1)}…`;
  return (
    `\n\n[atlas:knowledge] O que o AtlasDeck já sabe sobre o dono e os clientes citados — ` +
    `use como base e NÃO pergunte de novo o que já está aqui. Se algo da tarefa contradizer isto, siga a tarefa.\n${body}`
  );
}

export async function buildDelegationContextSafe(
  input: { agentId: string; prompt: string },
  budgetMs = 2_500,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      buildDelegationContext(input),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), budgetMs);
      }),
    ]);
  } catch (err) {
    if (process.env.MEMORY_DEBUG === "1") console.warn("[delegation-context] failed:", err);
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
