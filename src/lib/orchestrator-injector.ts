/**
 * Writes the orchestrator's runtime context — tool definitions, current
 * sub-agent roster, in-flight tasks, learned preferences, autonomous mode —
 * into the orchestrator's workspace `MEMORY.md` between dedicated markers.
 *
 * OpenClaw loads MEMORY.md as part of standard workspace context, so this
 * is how Jarvis "learns" about its tools and the state of the swarm without
 * a custom request-time injection (which OpenClaw 2026.5.x doesn't expose
 * a hook for).
 *
 * Idempotent. Safe to call on a cron + after any orchestration mutation
 * (new task delegated, agent created, settings changed).
 */
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import { OPENCLAW_DIR } from "@/lib/paths";
import { getAllAgentMeta } from "@/lib/agents-meta";
import { listTasks } from "@/lib/tasks-db";
import { getPreferencesForPrompt } from "@/lib/preference-model";
import { getOrchestrationSettings, isAutonomousFor } from "@/lib/orchestration-settings";
import { renderToolDocs, TOOL_DEFINITIONS } from "@/lib/orchestrator-tools";
import { listEventsInRange } from "@/lib/calendar-db";
import { listMemories } from "@/lib/memory-db";

const BEGIN = "<!-- BEGIN ATLASDECK ORCHESTRATOR — do not edit; this section regenerates -->";
const END = "<!-- END ATLASDECK ORCHESTRATOR -->";

export interface OrchestratorInjectionResult {
  agent_id: string;
  memory_file: string;
  bytes_written: number;
  changed: boolean;
  skipped_reason?: string;
}

interface AgentLike {
  id: string;
  name?: string;
  workspace?: string;
}

/**
 * Resolve the absolute path for the orchestrator's workspace, mirroring
 * the fallback strategy from task-workspace.ts: prefer the configured
 * OpenClaw dir when it exists and is writable, otherwise drop into
 * AtlasDeck's local `data/dev-workspaces/` so dev environments without
 * /root/.openclaw still get a real MEMORY.md file.
 */
function resolveWorkspaceAbsPath(workspace: string): string {
  if (!workspace) return "";
  if (path.isAbsolute(workspace)) return workspace;

  // Production: OpenClaw dir exists and we can write — use it.
  if (fsSync.existsSync(OPENCLAW_DIR)) {
    try {
      fsSync.accessSync(OPENCLAW_DIR, fsSync.constants.W_OK);
      return path.join(OPENCLAW_DIR, workspace);
    } catch {
      // fall through
    }
  }
  // Dev fallback: strip the leading "./workspace/" if any so we don't
  // double-nest, then put it under data/dev-workspaces/.
  const stripped = workspace.replace(/^\.\/?workspace\//, "").replace(/^\.\//, "");
  return path.join(process.cwd(), "data", "dev-workspaces", stripped);
}

function splice(existing: string, payload: string): string {
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END);
  const block = `${BEGIN}\n## Orchestrator (managed by AtlasDeck)\n_Atualizado em ${new Date().toISOString()}_\n\n${payload}\n${END}`;

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + END.length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n").trim() + "\n";
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function buildPayload(
  orchestrator: AgentLike,
  peers: Array<AgentLike & { role?: string; specialty?: string[]; briefing_checklist?: string[] }>,
): string {
  const settings = getOrchestrationSettings();
  const autonomous = isAutonomousFor(undefined); // global flag (orchestrators usually inherit)

  const subAgents = peers.filter((a) => a.id !== orchestrator.id);
  const subList = subAgents.length
    ? subAgents
        .map((a) => {
          const head = `- \`${a.id}\` — ${a.name || a.id} · papel: ${a.role || "specialist"} · skills: ${(a.specialty ?? []).join(", ") || "(generalista)"}`;
          const checklist = (a.briefing_checklist ?? []).filter((q) => q && q.trim());
          if (!checklist.length) return head;
          const items = checklist.map((q) => `    - ${q}`).join("\n");
          return `${head}\n  Antes de delegar, confirme com o usuário:\n${items}`;
        })
        .join("\n")
    : "_(nenhum sub-agente cadastrado ainda)_";

  // Snapshot of tasks in flight (visible to the orchestrator so it doesn't
  // re-delegate work that's already running).
  const active = listTasks({
    status: ["planning", "inbox", "assigned", "in_progress", "testing", "review"],
    limit: 30,
    sort: "newest",
  });
  const activeList = active.length
    ? active
        .map(
          (t) =>
            `- [${t.status}] \`${t.id.slice(0, 8)}\` → \`${t.assigned_to ?? "—"}\`: ${t.title || t.prompt.slice(0, 80)}`,
        )
        .join("\n")
    : "_(nenhuma task em voo)_";

  const prefs = getPreferencesForPrompt(orchestrator.id, 6);
  const prefsBlock = prefs ? prefs : "_(ainda sem preferências aprendidas)_";

  // Calendar: last 48h + next 7 days
  const now = new Date();
  const past48h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const next7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  let calendarBlock = "_(nenhum evento nos próximos 7 dias)_";
  try {
    const events = listEventsInRange(past48h, next7d).filter((e) => e.status !== "cancelled");
    if (events.length) {
      const fmtDate = (iso: string) => {
        const d = new Date(iso);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      calendarBlock = events
        .map((e) => {
          const past = new Date(e.start_at) < now ? "[passado]" : "[futuro]";
          const loc = e.location ? ` @ ${e.location}` : "";
          return `- ${past} ${fmtDate(e.start_at)} — **${e.title}**${loc}`;
        })
        .join("\n");
    }
  } catch {}

  // Recent meeting memories (episodic, tag "transcricao", last 5)
  let meetingsBlock = "_(nenhuma reunião registrada recentemente)_";
  try {
    const { memories } = listMemories({ type: "episodic", sort: "created", limit: 20, archived: false });
    const meeting = memories.filter((m) => m.tags.includes("transcricao")).slice(0, 5);
    if (meeting.length) {
      meetingsBlock = meeting
        .map((m) => {
          const date = m.created_at.slice(0, 10);
          const summary = m.summary || m.content.slice(0, 160);
          return `- **${m.title}** (${date}): ${summary}`;
        })
        .join("\n");
    }
  } catch {}

  const toolList = TOOL_DEFINITIONS.map((t) => `- **${t.name}** — ${t.description.split(".")[0]}.`).join("\n");

  // Delegation policy. Only push proactive delegation when there are
  // actually sub-agents to delegate to — otherwise instruct Jarvis to
  // just do the work inline (delegating to nobody would stall the task).
  const delegationPolicy = subAgents.length
    ? [
        `### Política de delegação (IMPORTANTE — comportamento padrão)`,
        `Você é AUTÔNOMO. NÃO espere o usuário pedir "delegue" — decida sozinho.`,
        ``,
        `Para CADA pedido, classifique:`,
        `- **Operacional** (escrever/corrigir código, mexer em arquivos, rodar comando, pesquisar a fundo, diagnosticar, implementar feature, tarefa multi-passo) → **DELEGUE automaticamente** via \`delegate_to\` (1 especialista) ou \`decompose\` (vários, com dependências). Isso cria os cards no painel Live Mission e o usuário acompanha o trabalho em tempo real.`,
        `- **Conversa / pergunta trivial** (bom dia, dúvida rápida, status, algo que você responde em 1-2 frases) → responda você mesmo direto, SEM delegar.`,
        ``,
        `Na dúvida entre os dois, prefira DELEGAR — é a essência do sistema: o usuário quer ver os especialistas trabalhando, não você fazendo tudo sozinho no chat.`,
        ``,
        `#### Pipeline de equipe (pedidos com VÁRIAS etapas) — USE \`decompose\``,
        `Quando o pedido tem etapas de naturezas diferentes (ex: "pesquise X e monte uma página web"), NÃO delegue só a primeira etapa — monte o pipeline COMPLETO de uma vez com \`decompose\`, encadeando especialistas via \`depends_on\`:`,
        "",
        "```atlas-tool decompose",
        `{ "parent_prompt": "pesquisar top 20 AS do Brasil e publicar página web", "subtasks": [`,
        `  { "agent_id": "pesquisador", "task": "Pesquisar e rankear os top 20 AS do Brasil com fontes" },`,
        `  { "agent_id": "escritor", "task": "Transformar a pesquisa em texto editorial pt-BR", "depends_on": ["0"] },`,
        `  { "agent_id": "dev", "task": "Construir a página web com o texto, branding Layer7", "depends_on": ["1"] },`,
        `  { "agent_id": "revisor", "task": "Revisar a página publicada e apontar correções", "depends_on": ["2"] }`,
        `] }`,
        "```",
        "",
        `O sistema cuida do resto AUTOMATICAMENTE: cada etapa só começa quando a anterior for concluída E aprovada, e a entrega da etapa anterior é injetada na próxima (o dev recebe o texto do escritor, etc.). Você NÃO precisa re-disparar nada entre etapas. O usuário aprova cada entrega pelo Telegram ou pelo painel.`,
        ``,
        `Fluxo correto de um pedido operacional:`,
        `1. Emita o(s) bloco(s) \`atlas-tool\` para delegar (delegate_to / decompose).`,
        `2. Responda ao usuário no chat com um briefing curto: o que você delegou, pra quem, e que ele pode acompanhar no Live Mission.`,
        `Delegar o TRABALHO e mesmo assim dar a resposta/briefing direto no chat NÃO é contradição — é o esperado.`,
        "",
      ].join("\n")
    : [
        `### Política de delegação`,
        `Ainda não há sub-agentes especializados cadastrados, então execute as tarefas você mesmo e responda direto no chat.`,
        `(Quando o usuário cadastrar especialistas no /agents, você passa a delegar automaticamente os pedidos operacionais.)`,
        "",
      ].join("\n");

  return [
    `### Você é o orquestrador "${orchestrator.id}"`,
    `Sua função: receber os pedidos do usuário, DELEGAR automaticamente as tarefas operacionais para sub-agentes especializados, revisar resultados e entregar o briefing ao usuário.`,
    "",
    delegationPolicy,
    `#### Comportamento Consultivo (IMPORTANTE)`,
    `Muitos usuários fazem pedidos vagos ("crie um relatório financeiro", "escreva um artigo"). NÃO delegue às cegas — enriqueça o pedido primeiro:`,
    `1. **Detecte ambiguidade.** Se o pedido não traz o suficiente para um especialista entregar bem (falta formato, objetivo, público, período, escopo...), PERGUNTE antes de delegar.`,
    `2. **Use o checklist de briefing do sub-agente alvo** (listado abaixo em "Sub-agentes disponíveis") para saber o que perguntar. Pergunte só o que está faltando.`,
    `3. **Seja conciso:** no máximo 3-4 perguntas de cada vez, as de maior impacto.`,
    `4. **Sempre ofereça um default** para cada pergunta ("se não disser, eu faço X"), para o usuário poder responder "tanto faz, segue" sem travar.`,
    `5. Quando tiver as respostas (ou o usuário disser para seguir com os defaults), monte um briefing completo e aí sim delegue via \`delegate_to\`, passando esse briefing no campo \`context\`.`,
    `6. Pedidos simples e claros NÃO precisam de entrevista — delegue direto.`,
    `Você fala direto com o usuário no chat; para perguntar basta responder em texto e aguardar a próxima mensagem (não precisa de tool para isso).`,
    "",
    `**Modo Autônomo (global):** ${autonomous ? "🚀 LIGADO (executa sem pedir aprovação)" : "🛑 DESLIGADO (sempre pedir aprovação)"}`,
    `**Aprovação humana antes de \"done\":** ${settings.require_user_approval ? "obrigatória" : "desligada"}`,
    `**Cost caps:** ${settings.cost_caps_enforce ? "aplicados pelo dispatcher" : "advisory only"}`,
    "",
    `#### Ferramentas disponíveis`,
    toolList,
    "",
    `Veja a documentação completa de cada tool abaixo ↓`,
    "",
    `#### Sub-agentes disponíveis`,
    subList,
    "",
    `#### Tarefas em voo (snapshot)`,
    activeList,
    "",
    `#### Preferências aprendidas do usuário`,
    prefsBlock,
    "",
    `#### Agenda (últimas 48h + próximos 7 dias)`,
    calendarBlock,
    "",
    `#### Reuniões recentes (memória)`,
    meetingsBlock,
    "",
    `---`,
    "",
    `### Como invocar uma tool`,
    `**PREFIRA chamar as tools NATIVAS diretamente (tool calling).** As ferramentas \`list_squad\`, \`delegate_to\`, \`decompose\` e \`check_progress\` estão disponíveis como tools nativas (via MCP \`atlasdeck-memory\`) em TODOS os canais — Telegram, WhatsApp, web. Chamá-las cria os cards no Live Mission na hora, em qualquer canal.`,
    `Fluxo: se não tiver certeza do \`agent_id\`, chame \`list_squad\` primeiro; depois \`delegate_to\` (1 especialista) ou \`decompose\` (vários).`,
    "",
    `**Fallback (só no chat web):** se as tools nativas não estiverem expostas no seu ambiente, emita um bloco fenced \`atlas-tool\` com o JSON — o runner do chat web captura:`,
    "",
    "```atlas-tool delegate_to",
    `{ "agent_id": "dev", "task": "implementar paginação no /list" }`,
    "```",
    `(Esse bloco de texto NÃO funciona no Telegram/WhatsApp — nesses canais use SEMPRE as tools nativas.)`,
    "",
    `### Documentação das tools`,
    "",
    renderToolDocs(),
  ].join("\n");
}

/**
 * Inject the orchestrator block into a single agent's MEMORY.md. Skipped
 * silently if the agent has no `workspace` configured (config is malformed).
 */
export async function injectOrchestratorContext(
  orchestrator: AgentLike,
  peers: Array<AgentLike & { role?: string; specialty?: string[]; briefing_checklist?: string[] }>,
): Promise<OrchestratorInjectionResult> {
  if (!orchestrator.workspace) {
    return {
      agent_id: orchestrator.id,
      memory_file: "",
      bytes_written: 0,
      changed: false,
      skipped_reason: "missing workspace",
    };
  }

  const wsAbs = resolveWorkspaceAbsPath(orchestrator.workspace);
  if (!wsAbs) {
    return {
      agent_id: orchestrator.id,
      memory_file: "",
      bytes_written: 0,
      changed: false,
      skipped_reason: "workspace path unresolved",
    };
  }
  // If the workspace dir doesn't exist (dev / fresh install), create it
  // — same behaviour as ensureAgentWorkspace in /api/agents POST.
  if (!fsSync.existsSync(wsAbs)) {
    try {
      fsSync.mkdirSync(wsAbs, { recursive: true });
    } catch (e) {
      return {
        agent_id: orchestrator.id,
        memory_file: "",
        bytes_written: 0,
        changed: false,
        skipped_reason: `mkdir failed: ${(e as Error).message}`,
      };
    }
  }

  const memoryFile = path.join(wsAbs, "MEMORY.md");

  let existing = "";
  try {
    existing = await fs.readFile(memoryFile, "utf-8");
  } catch {
    existing = "# MEMORY\n";
  }

  const payload = buildPayload(orchestrator, peers);
  const next = splice(existing, payload);

  if (next === existing) {
    return { agent_id: orchestrator.id, memory_file: memoryFile, bytes_written: 0, changed: false };
  }
  await fs.writeFile(memoryFile, next, "utf-8");
  return {
    agent_id: orchestrator.id,
    memory_file: memoryFile,
    bytes_written: Buffer.byteLength(next, "utf-8"),
    changed: true,
  };
}

const PROMPT_BEGIN = "<!-- BEGIN ATLASDECK AGENT PROMPT — do not edit; regenerates on save -->";
const PROMPT_END = "<!-- END ATLASDECK AGENT PROMPT -->";

function splicePrompt(existing: string, systemPrompt: string): string {
  const block = `${PROMPT_BEGIN}\n## Instruções do Agente\n\n${systemPrompt.trim()}\n${PROMPT_END}`;
  const beginIdx = existing.indexOf(PROMPT_BEGIN);
  const endIdx = existing.indexOf(PROMPT_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + PROMPT_END.length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n").trim() + "\n";
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function removePromptSection(existing: string): string {
  const beginIdx = existing.indexOf(PROMPT_BEGIN);
  const endIdx = existing.indexOf(PROMPT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return existing;
  const before = existing.slice(0, beginIdx).trimEnd();
  const after = existing.slice(endIdx + PROMPT_END.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n").trim() + "\n";
}

/**
 * Writes (or removes) the custom system_prompt section in a specialist
 * agent's workspace MEMORY.md. Called after POST/PUT to /api/agents when
 * the system_prompt field changes. Idempotent — safe to call repeatedly.
 */
export async function injectAgentSystemPrompt(
  agent: AgentLike,
  systemPrompt: string | undefined,
): Promise<OrchestratorInjectionResult> {
  if (!agent.workspace) {
    return { agent_id: agent.id, memory_file: "", bytes_written: 0, changed: false, skipped_reason: "missing workspace" };
  }
  const wsAbs = resolveWorkspaceAbsPath(agent.workspace);
  if (!wsAbs) {
    return { agent_id: agent.id, memory_file: "", bytes_written: 0, changed: false, skipped_reason: "workspace path unresolved" };
  }
  if (!fsSync.existsSync(wsAbs)) {
    try { fsSync.mkdirSync(wsAbs, { recursive: true }); } catch (e) {
      return { agent_id: agent.id, memory_file: "", bytes_written: 0, changed: false, skipped_reason: `mkdir failed: ${(e as Error).message}` };
    }
  }

  const memoryFile = path.join(wsAbs, "MEMORY.md");
  let existing = "";
  try { existing = await fs.readFile(memoryFile, "utf-8"); } catch { existing = "# MEMORY\n"; }

  const next = systemPrompt?.trim()
    ? splicePrompt(existing, systemPrompt)
    : removePromptSection(existing);

  if (next === existing) {
    return { agent_id: agent.id, memory_file: memoryFile, bytes_written: 0, changed: false };
  }
  await fs.writeFile(memoryFile, next, "utf-8");
  return { agent_id: agent.id, memory_file: memoryFile, bytes_written: Buffer.byteLength(next, "utf-8"), changed: true };
}

/**
 * Refresh every orchestrator's MEMORY.md. `peers` is the full agent list
 * (the caller supplies it — usually from /api/agents response).
 */
export async function refreshAllOrchestrators(
  peers: Array<AgentLike & { role?: string; specialty?: string[]; briefing_checklist?: string[] }>,
): Promise<OrchestratorInjectionResult[]> {
  const meta = getAllAgentMeta();
  const orchestrators = peers.filter(
    (p) => (meta[p.id]?.role ?? "specialist") === "orchestrator" || p.id === "main" || p.id === "jarvis",
  );
  const out: OrchestratorInjectionResult[] = [];
  for (const o of orchestrators) {
    out.push(await injectOrchestratorContext(o, peers));
  }
  return out;
}
