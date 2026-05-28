/**
 * Memory injection: writes a managed "Auto-Recall" section directly
 * into each workspace's MEMORY.md so that the OpenClaw agent reads it
 * on session boot (OpenClaw already loads MEMORY.md as part of its
 * standard workspace context).
 *
 * The managed section is delimited by HTML comments. Anything outside
 * the markers is preserved verbatim — the user's hand-written content
 * is never overwritten.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  listMemories,
  getSettings,
  type MemoryRow,
} from "@/lib/memory-db";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import {
  getOpenClawWorkspace,
  getAgentWorkspacePath,
} from "@/lib/openclaw-config";
import { indexFile } from "@/lib/memory-fts";
import { buildPromptBlock } from "@/lib/memory-extractor";

const BEGIN_MARK = "<!-- BEGIN ATLASDECK AUTO-RECALL — do not edit; this section regenerates -->";
const END_MARK = "<!-- END ATLASDECK AUTO-RECALL -->";

/**
 * Tool-usage guidance for the agent. Without this, the LLM tends to
 * "remember" things from session context and skip the tool entirely
 * — which means nothing ever lands in the SQLite store and the UI
 * counter stays at 0 even though the user feels remembered.
 *
 * Injected ABOVE the auto-recall list because reading order matters
 * for some models — the directive comes before the data it operates on.
 */
const TOOL_GUIDANCE = `### Ferramentas de memória persistente — USE ATIVAMENTE

Você tem ferramentas do servidor MCP \`atlasdeck-memory\` que persistem
informação entre sessões. O conteúdo da sessão atual NÃO é memória — é
contexto temporário. Para algo durar, **chame as tools**.

- **\`memory_add\`** — SEMPRE chame quando:
  - O usuário pedir "lembre", "salve", "anote", "guarde", "memorize"
  - Você notar uma **preferência durável** (idioma, formato de resposta,
    estilo de comunicação, restrição operacional)
  - O usuário compartilhar algo **identitário** (nome, papel, localização,
    horários, projetos em andamento)
  - Uma **decisão de configuração/projeto** for fechada na conversa
  - O usuário disser "sempre" ou "nunca" sobre algo

- **\`memory_search\`** — SEMPRE chame ANTES de responder quando:
  - A pergunta é "você lembra X?", "o que você sabe sobre Y?",
    "qual minha preferência de Z?"
  - O contexto pode ter sido falado em uma sessão passada
  - Você precisa de uma preferência armazenada pra formatar a resposta

- **\`memory_update\`** — quando o usuário **corrigir** algo já salvo
  ("na verdade não é X, é Y") — não duplique, atualize.

- **\`memory_remove\`** — apenas quando o usuário pedir explicitamente
  pra esquecer.

**Importance** (parâmetro de \`memory_add\`):
\`0.85+\` → quando o usuário falou "sempre/nunca/lembre" ou é identidade.
\`0.70\` → preferência forte mas casual.
\`0.50\` → informação relevante mas não crítica.

**Não pergunte permissão** pra salvar — só salve. Se quiser confirmar,
responda naturalmente e a tool já será chamada em paralelo.
`;

export interface InjectionOptions {
  maxMemories?: number;
  includePinned?: boolean;
  includeReflections?: boolean;
}

export interface InjectionResult {
  workspace: string;
  memoryFile: string;
  memoriesInjected: number;
  bytesWritten: number;
  changed: boolean;
}

function score(memory: MemoryRow): number {
  // Composite ranking: importance dominant, recency + access tiebreak
  const importance = memory.importance ?? 0;
  const accessBonus = Math.min(memory.access_count, 20) * 0.005;
  const recency = memory.last_accessed_at
    ? Date.parse(memory.last_accessed_at)
    : Date.parse(memory.created_at);
  const ageDays = Math.max(0, (Date.now() - recency) / (1000 * 60 * 60 * 24));
  const recencyBonus = Math.exp(-ageDays / 30) * 0.1;
  return importance + accessBonus + recencyBonus;
}

export async function buildRecallBlock(
  workspace: string,
  opts: InjectionOptions = {},
): Promise<{ block: string; memories: MemoryRow[] }> {
  const max = Math.min(Math.max(opts.maxMemories ?? 20, 1), 80);

  const { memories: pinned } = listMemories({
    workspace,
    pinned: true,
    archived: false,
    limit: max,
    sort: "importance",
  });

  const { memories: top } = listMemories({
    workspace,
    archived: false,
    limit: max * 2,
    sort: "importance",
  });

  const seen = new Set<string>();
  const merged: MemoryRow[] = [];
  for (const m of pinned) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  for (const m of top.sort((a, b) => score(b) - score(a))) {
    if (merged.length >= max) break;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }

  const block = buildPromptBlock(merged);
  return { block, memories: merged };
}

function spliceManagedSection(existing: string, payload: string): string {
  const beginIdx = existing.indexOf(BEGIN_MARK);
  const endIdx = existing.indexOf(END_MARK);

  const managedBlock = `${BEGIN_MARK}\n## Auto-Recall (managed by AtlasDeck)\n_Atualizado em ${new Date().toISOString()}_\n\n${payload}\n${END_MARK}`;

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + END_MARK.length).trimStart();
    return [before, managedBlock, after].filter(Boolean).join("\n\n").trim() + "\n";
  }

  const base = existing.trimEnd();
  if (!base) return `${managedBlock}\n`;
  return `${base}\n\n${managedBlock}\n`;
}

export async function injectIntoWorkspace(
  workspace: string,
  opts: InjectionOptions = {},
): Promise<InjectionResult> {
  const settings = getSettings();
  if (!settings.inject_into_memory_md) {
    return {
      workspace,
      memoryFile: "",
      memoriesInjected: 0,
      bytesWritten: 0,
      changed: false,
    };
  }

  // Resolve the on-disk workspace path. "workspace" is the convention
  // memory-extractor uses for the main agent, but the real on-disk
  // path comes from openclaw.json (`agents.list[id=main].workspace`),
  // NOT from AtlasDeck's data/openclaw-config.json — those two can
  // drift apart (auto-fix occasionally rewrites the latter to
  // <OPENCLAW_DIR>/workspace without /mission-control, which is
  // wrong and leaves MEMORY.md in a folder no agent reads).
  // Reading openclaw.json directly guarantees we write where the
  // daemon will actually look on next session boot.
  let wsPath: string | null = null;
  if (workspace === "workspace") {
    wsPath = getAgentWorkspacePath("main") ?? getOpenClawWorkspace();
  } else if (workspace.startsWith("workspace-")) {
    const agentId = workspace.slice("workspace-".length);
    wsPath = getAgentWorkspacePath(agentId) ?? resolveWorkspacePath(workspace);
  } else {
    wsPath = resolveWorkspacePath(workspace);
  }
  if (!wsPath) {
    return {
      workspace,
      memoryFile: "",
      memoriesInjected: 0,
      bytesWritten: 0,
      changed: false,
    };
  }

  const memoryFile = path.join(wsPath, "MEMORY.md");

  let existing = "";
  try {
    existing = await fs.readFile(memoryFile, "utf-8");
  } catch {
    // MEMORY.md may not exist yet — that's fine, we'll create it
    existing = "# MEMORY\n";
  }

  const { block, memories } = await buildRecallBlock(workspace, opts);
  const recallPayload = block.trim() ? block : "_(sem memórias relevantes ainda)_";
  // Tool guidance comes first so the LLM reads "USE the tools" before
  // it reads the data those tools operate on.
  const payload = `${TOOL_GUIDANCE}\n${recallPayload}`;
  const next = spliceManagedSection(existing, payload);

  if (next === existing) {
    return {
      workspace,
      memoryFile,
      memoriesInjected: memories.length,
      bytesWritten: 0,
      changed: false,
    };
  }

  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, next, "utf-8");

  // Keep FTS index in sync
  await indexFile(workspace, "MEMORY.md", memoryFile);

  return {
    workspace,
    memoryFile,
    memoriesInjected: memories.length,
    bytesWritten: Buffer.byteLength(next, "utf-8"),
    changed: true,
  };
}

/**
 * Inject across every workspace that has at least one memory PLUS
 * the canonical "workspace" (main agent). We always touch "workspace"
 * because the injected block also carries the tool-usage guidance —
 * the agent needs that on first boot even before any memory exists,
 * otherwise the LLM never calls the MCP tools and the store stays
 * empty forever.
 */
export async function injectAllWorkspaces(
  opts: InjectionOptions = {},
): Promise<InjectionResult[]> {
  const { byWorkspace } = (await import("@/lib/memory-db")).getStats();
  const targets = new Set<string>(Object.keys(byWorkspace));
  targets.add("workspace");
  const results: InjectionResult[] = [];
  for (const workspace of targets) {
    try {
      results.push(await injectIntoWorkspace(workspace, opts));
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory-injector] failed for", workspace, err);
      }
    }
  }
  return results;
}
