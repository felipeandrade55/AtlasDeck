/**
 * Detection + attachment of custom memory/skills/KB resources that live
 * OUTSIDE OpenClaw's own state but that the user wants the agent to
 * consult when answering.
 *
 * Context: the user has a Python-based multi-agent system in
 * ~/.openclaw/agents/ with:
 *   - agent_memory.db   (SQLite RAG store with embeddings, importance, refs)
 *   - knowledge_base.json   (structured facts: apis, infra, projects, etc.)
 *   - skills/*.md        (curated agent skill docs)
 *   - handler_*.py       (per-agent task handlers, invoked by heartbeat cron)
 *   - sessions/*.jsonl   (per-conversation transcripts)
 *
 * OpenClaw itself doesn't know about any of this. The bot only sees its
 * `instructions.md` system prompt. So when the user asks "lembra do
 * OpenResty?", the bot has no idea to look in agent_memory.db.
 *
 * This module:
 *   - Detects which artifacts exist for an agent
 *   - Generates a markdown appendix that teaches the agent to query them
 *     via its `bash` tool
 *   - Attaches/detaches the appendix to/from instructions.md using fence
 *     markers (idempotent)
 *
 * Lives in AtlasDeck because OpenClaw config files (openclaw.json,
 * instructions.md) are managed by AtlasDeck's /agents UI.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { OPENCLAW_DIR } from "./paths";

// ─── Path constants ────────────────────────────────────────────────────

const AGENTS_DIR = path.join(OPENCLAW_DIR, "agents");
const SHARED_MEMORY_DB = path.join(AGENTS_DIR, "agent_memory.db");
const SHARED_KB_JSON = path.join(AGENTS_DIR, "knowledge_base.json");
const SHARED_SKILLS_DIR = path.join(AGENTS_DIR, "skills");

export const MEMORY_FENCE_BEGIN = "<!-- ATLASDECK:MEMORY-CONNECT BEGIN -->";
export const MEMORY_FENCE_END = "<!-- ATLASDECK:MEMORY-CONNECT END -->";

// ─── Types ─────────────────────────────────────────────────────────────

export interface SkillFile {
  name: string;
  path: string;
  /** First-line description if it looks like a markdown title or summary line */
  summary?: string;
  bytes: number;
}

export interface MemoryDbInfo {
  exists: boolean;
  path: string;
  entryCount?: number;
  agentsRepresented?: string[];
  bytes?: number;
}

export interface KnowledgeBaseInfo {
  exists: boolean;
  path: string;
  sections?: string[];
  bytes?: number;
}

export interface SkillsInfo {
  exists: boolean;
  path: string;
  files: SkillFile[];
  count: number;
}

export interface InstructionsInfo {
  exists: boolean;
  path: string;
  bytes: number;
  hasAppendix: boolean;
  appendixSize: number;
}

export interface SessionsInfo {
  exists: boolean;
  path: string;
  count: number;
  /** ISO timestamp of the most recent .jsonl mtime */
  latest: string | null;
}

export interface AgentMemoryResources {
  agentId: string;
  agentDir: string;
  shared: {
    memoryDb: MemoryDbInfo;
    knowledgeBase: KnowledgeBaseInfo;
    skills: SkillsInfo;
  };
  perAgent: {
    instructionsMd: InstructionsInfo;
    sessions: SessionsInfo;
  };
  /** True when there's at least ONE custom resource to expose */
  hasAnyResource: boolean;
  /** True when instructions.md already has the auto-appendix */
  isConnected: boolean;
}

// ─── Detection ─────────────────────────────────────────────────────────

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function detectMemoryDb(): MemoryDbInfo {
  const st = safeStat(SHARED_MEMORY_DB);
  if (!st?.isFile()) return { exists: false, path: SHARED_MEMORY_DB };
  // Try to count rows + list agent_name distinct values via sqlite3 CLI.
  // We avoid pulling in a sqlite npm dep — best-effort only.
  const out: MemoryDbInfo = { exists: true, path: SHARED_MEMORY_DB, bytes: st.size };
  try {
    const count = execSync(
      `sqlite3 "${SHARED_MEMORY_DB}" "SELECT COUNT(*) FROM agent_memory;"`,
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    const n = Number(count);
    if (Number.isFinite(n)) out.entryCount = n;
    const agents = execSync(
      `sqlite3 "${SHARED_MEMORY_DB}" "SELECT DISTINCT agent_name FROM agent_memory ORDER BY agent_name;"`,
      { encoding: "utf8", timeout: 3000 },
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (agents.length) out.agentsRepresented = agents;
  } catch {
    // sqlite3 CLI missing or schema differs — keep just bytes
  }
  return out;
}

function detectKnowledgeBase(): KnowledgeBaseInfo {
  const st = safeStat(SHARED_KB_JSON);
  if (!st?.isFile()) return { exists: false, path: SHARED_KB_JSON };
  const out: KnowledgeBaseInfo = { exists: true, path: SHARED_KB_JSON, bytes: st.size };
  try {
    const raw = fs.readFileSync(SHARED_KB_JSON, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      out.sections = Object.keys(parsed).filter((k) => !k.startsWith("_"));
    }
  } catch {
    // bad JSON — still report existence
  }
  return out;
}

function detectSkills(): SkillsInfo {
  const st = safeStat(SHARED_SKILLS_DIR);
  if (!st?.isDirectory()) {
    return { exists: false, path: SHARED_SKILLS_DIR, files: [], count: 0 };
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SHARED_SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return { exists: true, path: SHARED_SKILLS_DIR, files: [], count: 0 };
  }
  const files: SkillFile[] = [];
  for (const f of entries.sort()) {
    const full = path.join(SHARED_SKILLS_DIR, f);
    const s = safeStat(full);
    if (!s?.isFile()) continue;
    let summary: string | undefined;
    try {
      const head = fs.readFileSync(full, "utf8").split("\n").slice(0, 5);
      const titleLine = head.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "").trim();
      const firstNonEmpty = head.find((l) => l.trim() && !l.startsWith("#"))?.trim();
      summary = titleLine || firstNonEmpty;
      if (summary && summary.length > 140) summary = summary.slice(0, 137) + "…";
    } catch {}
    files.push({ name: f, path: full, summary, bytes: s.size });
  }
  return { exists: true, path: SHARED_SKILLS_DIR, files, count: files.length };
}

function detectInstructionsMd(agentId: string): InstructionsInfo {
  const p = path.join(AGENTS_DIR, agentId, "agent", "instructions.md");
  const st = safeStat(p);
  if (!st?.isFile()) {
    return { exists: false, path: p, bytes: 0, hasAppendix: false, appendixSize: 0 };
  }
  let content = "";
  try { content = fs.readFileSync(p, "utf8"); } catch {}
  const beginIdx = content.indexOf(MEMORY_FENCE_BEGIN);
  const endIdx = content.indexOf(MEMORY_FENCE_END);
  const hasAppendix = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;
  const appendixSize = hasAppendix ? (endIdx + MEMORY_FENCE_END.length) - beginIdx : 0;
  return { exists: true, path: p, bytes: st.size, hasAppendix, appendixSize };
}

function detectSessions(agentId: string): SessionsInfo {
  const p = path.join(AGENTS_DIR, agentId, "sessions");
  const st = safeStat(p);
  if (!st?.isDirectory()) return { exists: false, path: p, count: 0, latest: null };
  let files: string[] = [];
  try {
    files = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl"));
  } catch {}
  let latestMtime = 0;
  for (const f of files) {
    const s = safeStat(path.join(p, f));
    if (s && s.mtimeMs > latestMtime) latestMtime = s.mtimeMs;
  }
  return {
    exists: true,
    path: p,
    count: files.length,
    latest: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
  };
}

export function detectAgentMemoryResources(agentId: string): AgentMemoryResources {
  const cleanId = agentId.trim();
  const memoryDb = detectMemoryDb();
  const knowledgeBase = detectKnowledgeBase();
  const skills = detectSkills();
  const instructionsMd = detectInstructionsMd(cleanId);
  const sessions = detectSessions(cleanId);

  const hasAnyResource =
    memoryDb.exists || knowledgeBase.exists || skills.count > 0 || sessions.count > 0;

  return {
    agentId: cleanId,
    agentDir: path.join(AGENTS_DIR, cleanId),
    shared: { memoryDb, knowledgeBase, skills },
    perAgent: { instructionsMd, sessions },
    hasAnyResource,
    isConnected: instructionsMd.hasAppendix,
  };
}

// ─── Appendix generation ───────────────────────────────────────────────

export function buildMemoryAppendix(resources: AgentMemoryResources): string {
  const lines: string[] = [];
  lines.push(MEMORY_FENCE_BEGIN);
  lines.push("");
  lines.push("## [Auto] Como consultar memória persistente");
  lines.push("");
  lines.push("> Esta seção foi gerada automaticamente pelo AtlasDeck (/agents → 'Conectar Memória Custom').");
  lines.push("> NÃO edite manualmente entre os marcadores — qualquer alteração será sobrescrita ao reconectar.");
  lines.push("");
  lines.push("**ANTES de responder qualquer pergunta sobre o passado, projetos, infraestrutura, fatos sobre");
  lines.push("o usuário, ou qualquer coisa que possa estar registrada, CONSULTE estas fontes via `bash`:**");
  lines.push("");

  const { memoryDb, knowledgeBase, skills } = resources.shared;
  const { sessions } = resources.perAgent;

  let sectionNum = 1;

  if (memoryDb.exists) {
    lines.push(`### ${sectionNum}. Memória estruturada (${memoryDb.entryCount ?? "?"} entries indexadas)`);
    lines.push("");
    lines.push(`Banco SQLite com embeddings, importance score e contador de referências.`);
    lines.push(`Path: \`${memoryDb.path}\``);
    if (memoryDb.agentsRepresented?.length) {
      lines.push(`Agentes com memória registrada: \`${memoryDb.agentsRepresented.join(", ")}\``);
    }
    lines.push("");
    lines.push("Para buscar por palavra-chave (substitua KEYWORD):");
    lines.push("```bash");
    lines.push(`sqlite3 "${memoryDb.path}" \\`);
    lines.push(`  "SELECT id, category, key, content, importance FROM agent_memory \\`);
    lines.push(`   WHERE (content LIKE '%KEYWORD%' OR key LIKE '%KEYWORD%') \\`);
    lines.push(`   ORDER BY importance DESC, times_referenced DESC LIMIT 10;"`);
    lines.push("```");
    lines.push("");
    lines.push("Após usar uma entry, INCREMENTE o contador (mantém o ranking afiado):");
    lines.push("```bash");
    lines.push(`sqlite3 "${memoryDb.path}" \\`);
    lines.push(`  "UPDATE agent_memory SET times_referenced = times_referenced + 1, \\`);
    lines.push(`   updated_at = CURRENT_TIMESTAMP WHERE id = ID;"`);
    lines.push("```");
    lines.push("");
    sectionNum++;
  }

  if (knowledgeBase.exists) {
    lines.push(`### ${sectionNum}. Knowledge base estruturada`);
    lines.push("");
    lines.push(`JSON com fatos curados sobre o sistema, projetos, infra, etc.`);
    lines.push(`Path: \`${knowledgeBase.path}\``);
    if (knowledgeBase.sections?.length) {
      lines.push(`Seções disponíveis: \`${knowledgeBase.sections.join("`, `")}\``);
    }
    lines.push("");
    lines.push("Para ler uma seção específica:");
    lines.push("```bash");
    lines.push(`jq '.SECAO' "${knowledgeBase.path}"`);
    lines.push("```");
    lines.push("");
    lines.push("Para buscar por termo em todo o JSON:");
    lines.push("```bash");
    lines.push(`jq '..|strings|select(test("KEYWORD"; "i"))' "${knowledgeBase.path}" | head -20`);
    lines.push("```");
    lines.push("");
    sectionNum++;
  }

  if (sessions.exists && sessions.count > 0) {
    lines.push(`### ${sectionNum}. Sessões antigas (transcripts de conversas)`);
    lines.push("");
    lines.push(`${sessions.count} arquivo(s) .jsonl com histórico de conversas.`);
    lines.push(`Path: \`${sessions.path}/\``);
    lines.push("");
    lines.push("Para buscar conversas anteriores sobre um tema:");
    lines.push("```bash");
    lines.push(`grep -l -i "KEYWORD" ${sessions.path}/*.jsonl | head -5`);
    lines.push("```");
    lines.push("");
    lines.push("Para extrair texto de mensagens de um session específico:");
    lines.push("```bash");
    lines.push(`jq -r 'select(.role=="user" or .role=="assistant") | .content' SESSION.jsonl | head -50`);
    lines.push("```");
    lines.push("");
    sectionNum++;
  }

  if (skills.count > 0) {
    lines.push(`### ${sectionNum}. Skills disponíveis (${skills.count} arquivo(s) .md)`);
    lines.push("");
    lines.push(`Cada skill é um documento markdown com expertise pronta. Use \`cat <arquivo>\` quando o`);
    lines.push(`tema da conversa cair em um deles.`);
    lines.push("");
    for (const sk of skills.files) {
      const friendlyName = sk.name.replace(/\.md$/, "");
      const desc = sk.summary ? ` — ${sk.summary}` : "";
      lines.push(`- \`${sk.path}\` — **${friendlyName}**${desc}`);
    }
    lines.push("");
    lines.push("Exemplo de uso:");
    lines.push("```bash");
    lines.push(`cat ${skills.path}/<arquivo>.md`);
    lines.push("```");
    lines.push("");
    sectionNum++;
  }

  lines.push("---");
  lines.push("");
  lines.push("**Regra geral:** se a pergunta menciona algo passado, um sistema, projeto, infra,");
  lines.push("ou qualquer fato sobre o ambiente — **CONSULTE primeiro**, depois responda. Se não achar,");
  lines.push("aí sim diga que não tem o detalhe.");
  lines.push("");
  lines.push(MEMORY_FENCE_END);

  return lines.join("\n");
}

// ─── Attach / detach ──────────────────────────────────────────────────

export interface AttachResult {
  ok: boolean;
  message: string;
  path: string;
  beforeBytes: number;
  afterBytes: number;
  refreshed: boolean;
}

export function attachMemoryAppendix(agentId: string): AttachResult {
  const resources = detectAgentMemoryResources(agentId);
  const instrPath = resources.perAgent.instructionsMd.path;

  // Ensure dir + file exist
  fs.mkdirSync(path.dirname(instrPath), { recursive: true });
  let current = "";
  try { current = fs.readFileSync(instrPath, "utf8"); } catch { current = ""; }
  const beforeBytes = current.length;

  // If the appendix exists, replace it; otherwise append at end
  const beginIdx = current.indexOf(MEMORY_FENCE_BEGIN);
  const endIdx = current.indexOf(MEMORY_FENCE_END);
  const hasAppendix = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  const appendix = buildMemoryAppendix(resources);
  let next: string;
  if (hasAppendix) {
    const before = current.slice(0, beginIdx).replace(/\s+$/, "");
    const after = current.slice(endIdx + MEMORY_FENCE_END.length).replace(/^\s+/, "");
    next = (before ? before + "\n\n" : "") + appendix + (after ? "\n\n" + after : "") + "\n";
  } else {
    const trimmed = current.replace(/\s+$/, "");
    next = (trimmed ? trimmed + "\n\n" : "") + appendix + "\n";
  }

  fs.writeFileSync(instrPath, next, "utf8");

  return {
    ok: true,
    message: hasAppendix
      ? "Apêndice de memória atualizado (re-detectou recursos)"
      : "Apêndice de memória adicionado pela primeira vez",
    path: instrPath,
    beforeBytes,
    afterBytes: next.length,
    refreshed: hasAppendix,
  };
}

export interface DetachResult {
  ok: boolean;
  message: string;
  path: string;
  removedBytes: number;
}

export function detachMemoryAppendix(agentId: string): DetachResult {
  const resources = detectAgentMemoryResources(agentId);
  const instrPath = resources.perAgent.instructionsMd.path;
  if (!resources.perAgent.instructionsMd.exists) {
    return { ok: false, message: "instructions.md não existe", path: instrPath, removedBytes: 0 };
  }
  let current = "";
  try { current = fs.readFileSync(instrPath, "utf8"); } catch {
    return { ok: false, message: "não consegui ler instructions.md", path: instrPath, removedBytes: 0 };
  }
  const beginIdx = current.indexOf(MEMORY_FENCE_BEGIN);
  const endIdx = current.indexOf(MEMORY_FENCE_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { ok: false, message: "nenhum apêndice encontrado pra remover", path: instrPath, removedBytes: 0 };
  }
  const before = current.slice(0, beginIdx).replace(/\s+$/, "");
  const after = current.slice(endIdx + MEMORY_FENCE_END.length).replace(/^\s+/, "");
  const next = (before + (after ? "\n\n" + after : "") + "\n").replace(/^\n+/, "");
  const removedBytes = current.length - next.length;
  fs.writeFileSync(instrPath, next, "utf8");
  return {
    ok: true,
    message: "Apêndice de memória removido — Jarvis volta ao instructions.md original",
    path: instrPath,
    removedBytes,
  };
}
