/**
 * AtlasDeck-managed agent **instruction files** (AGENTS.md / SOUL.md / TOOLS.md).
 *
 * OpenClaw injects these workspace files into the agent's system prompt every
 * turn. Out of the box they ship as the generic OpenClaw template — full of
 * guidance for channels the install doesn't use (Discord/Slack reactions,
 * group-chat etiquette) that just adds noise.
 *
 * This module lets AtlasDeck own a **canonical, channel-aware "base" block**
 * inside each file, between markers, while preserving anything the user wrote
 * OUTSIDE the markers (e.g. the TTS config in TOOLS.md). Same idempotent-splice
 * pattern used by orchestrator-injector.ts for MEMORY.md.
 *
 * Deterministic by design (no LLM): the base is generated from the install's
 * channel config, so regenerating after enabling/disabling a channel keeps the
 * instructions in sync. An LLM "optimize" pass can layer on top later.
 */
import { promises as fs } from "fs";
import fsSync from "fs";
import os from "os";
import path from "path";
import {
  getOpenClawDir,
  resolveOpenClawAgentsConfigPath,
} from "@/lib/openclaw-config";

export const INSTRUCTION_MANAGED_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
] as const;
export type ManagedInstructionFile = (typeof INSTRUCTION_MANAGED_FILES)[number];

const BEGIN =
  "<!-- BEGIN ATLASDECK BASE — gerado pelo AtlasDeck; edite fora deste bloco -->";
const END = "<!-- END ATLASDECK BASE -->";
// Tolerant matchers so blocks written by earlier/manual variants of the marker
// text are still recognized (otherwise a regenerate would duplicate the block).
const BEGIN_RE = /<!--\s*BEGIN ATLASDECK BASE[\s\S]*?-->/;
const END_RE = /<!--\s*END ATLASDECK BASE[\s\S]*?-->/;

export interface ChannelContext {
  telegram: boolean;
  whatsapp: boolean;
  discord: boolean;
  slack: boolean;
  web: boolean;
  /** pt-BR labels of the active conversational channels (web always last). */
  active: string[];
}

/**
 * Read the install's **configured** channels straight from openclaw.json.
 *
 * We key off presence in `channels` (configured), NOT `enabled`: a channel the
 * user set up but toggled off (e.g. WhatsApp in passive mode) should still be
 * reflected in the agent's instructions, since messages can still arrive there.
 * Channels that are entirely absent from config (Discord/Slack on a
 * Telegram/WhatsApp install) are the ones we deliberately leave out.
 */
export function detectChannels(): ChannelContext {
  const ctx: ChannelContext = {
    telegram: false,
    whatsapp: false,
    discord: false,
    slack: false,
    web: true,
    active: [],
  };
  try {
    const { path: cfgPath } = resolveOpenClawAgentsConfigPath();
    const parsed = JSON.parse(fsSync.readFileSync(cfgPath, "utf8")) as {
      channels?: Record<string, unknown>;
    };
    const ch = parsed.channels || {};
    const configured = (k: string) => ch[k] != null && typeof ch[k] === "object";
    ctx.telegram = configured("telegram");
    ctx.whatsapp = configured("whatsapp");
    ctx.discord = configured("discord");
    ctx.slack = configured("slack");
  } catch {
    // openclaw.json unreadable — fall back to web-only (always-true).
  }
  const labels: string[] = [];
  if (ctx.telegram) labels.push("Telegram");
  if (ctx.whatsapp) labels.push("WhatsApp");
  if (ctx.discord) labels.push("Discord");
  if (ctx.slack) labels.push("Slack");
  labels.push("interface web do AtlasDeck");
  ctx.active = labels;
  return ctx;
}

function deriveAgentName(agentId: string): string {
  try {
    const { path: cfgPath } = resolveOpenClawAgentsConfigPath();
    const parsed = JSON.parse(fsSync.readFileSync(cfgPath, "utf8")) as {
      agents?: { list?: Array<{ id?: string; name?: string }> };
    };
    const entry = parsed.agents?.list?.find((a) => a?.id === agentId);
    if (entry?.name) return entry.name;
  } catch {
    /* ignore */
  }
  return agentId === "main" ? "Jarvis" : agentId;
}

// ─── Base content generators (channel-aware) ───────────────────────────────

function buildAgentsBase(ch: ChannelContext, agentName: string): string {
  const lines: string[] = [
    `# AGENTS.md — Workspace do ${agentName}`,
    "",
    `Este diretório é sua casa e sua memória. Você conversa com o usuário por estes canais: **${ch.active.join(
      ", ",
    )}**.`,
    "",
    "## Início de sessão",
    "Use o contexto de startup já fornecido pelo runtime (este arquivo, SOUL.md, USER.md, IDENTITY.md, MEMORY.md e a memória diária). **Não releia esses arquivos** a menos que: (1) o usuário peça, (2) falte algo no contexto fornecido, ou (3) precise de um aprofundamento específico.",
    "",
    "## Memória",
    "- **Diário:** `memory/AAAA-MM-DD.md` — log cru do que aconteceu.",
    "- **Longo prazo:** `MEMORY.md` — memória curada. **Só carregue/edite na sessão principal**; nunca em contexto compartilhado, por segurança.",
    '- Quer lembrar de algo? **Escreva no arquivo.** "Nota mental" não sobrevive ao restart. Texto > cérebro.',
    "",
    "## Linhas vermelhas",
    "- Nunca exfiltre dados privados.",
    "- Não rode comandos destrutivos sem perguntar. Prefira `trash` a `rm`.",
    "- Na dúvida, pergunte.",
    "",
    "## Externo vs. interno",
    "- **Livre:** ler arquivos, explorar, organizar, pesquisar na web, trabalhar no workspace.",
    "- **Pergunte antes:** enviar e-mails, publicar qualquer coisa, ou qualquer ação que saia da máquina.",
    "",
    "## Canais e formatação",
    "- Seja conciso por padrão; aprofunde quando importar. Não mande respostas pela metade — uma resposta boa vale mais que três fragmentos.",
  ];
  if (ch.telegram || ch.whatsapp) {
    const msg = [ch.telegram && "Telegram", ch.whatsapp && "WhatsApp"]
      .filter(Boolean)
      .join(" / ");
    lines.push(
      `- **${msg}:** markdown é limitado. Use **negrito** e listas; evite tabelas grandes.${
        ch.whatsapp ? " No WhatsApp, prefira **negrito**/CAPS a cabeçalhos." : ""
      }`,
    );
  }
  if (ch.web) {
    lines.push(
      "- **Interface web do AtlasDeck:** renderiza markdown completo — pode usar títulos, tabelas e blocos de código à vontade.",
    );
  }
  if (ch.discord || ch.slack) {
    const msg = [ch.discord && "Discord", ch.slack && "Slack"]
      .filter(Boolean)
      .join(" / ");
    lines.push(
      `- **${msg}:** sem tabelas (use listas). Em grupo, participe sem dominar; reaja com emoji quando fizer sentido em vez de responder.`,
    );
  }
  lines.push(
    "",
    "## Proatividade (heartbeat)",
    "Ao receber um heartbeat, não responda só `HEARTBEAT_OK` sempre. Faça trabalho de fundo útil (organizar memória, checar projetos) e fale com o usuário quando houver algo que valha a pena. Fique quieto (`HEARTBEAT_OK`) de madrugada (23h–8h) salvo urgência, ou quando nada mudou desde a última checagem.",
  );
  return lines.join("\n");
}

function buildSoulBase(agentName: string): string {
  return [
    `# SOUL.md — Quem você é`,
    "",
    `Você não é um chatbot. Você é o ${agentName} — o assistente do usuário.`,
    "",
    "## Verdades centrais",
    '- **Ajude de verdade, não pra cena.** Pule o "Ótima pergunta!" e o "Fico feliz em ajudar!" — só ajude. Ações falam mais que palavras de enchimento.',
    "- **Tenha opinião.** Pode discordar, preferir coisas, achar graça. Assistente sem personalidade é uma busca com passos a mais.",
    "- **Seja resourceful antes de perguntar.** Tente descobrir: leia o arquivo, cheque o contexto, pesquise. Aí pergunte se travar. Volte com respostas, não com perguntas.",
    "- **Conquiste confiança por competência.** O usuário te deu acesso às coisas dele. Cuidado com ações externas; ousadia nas internas (ler, organizar, aprender).",
    "- **Você é um convidado.** Tem acesso à vida de alguém. Trate com respeito.",
    "",
    "## Limites",
    "- Coisas privadas continuam privadas. Ponto.",
    "- Na dúvida, pergunte antes de agir externamente.",
    "- Nunca mande respostas mal-acabadas.",
    "",
    "## Vibe",
    "Conciso quando precisa, minucioso quando importa. Nem corporativo, nem puxa-saco. Só... bom.",
  ].join("\n");
}

function buildToolsBase(): string {
  return [
    "# TOOLS.md — Notas locais",
    "",
    "As skills definem *como* as ferramentas funcionam. Aqui ficam só as **suas especificidades** (hosts SSH, vozes de TTS, nomes de dispositivos, nicknames). Adicione o que for útil **abaixo do bloco gerenciado** — o AtlasDeck preserva tudo que estiver fora dos marcadores.",
  ].join("\n");
}

function buildBase(
  file: ManagedInstructionFile,
  ch: ChannelContext,
  agentName: string,
): string {
  switch (file) {
    case "AGENTS.md":
      return buildAgentsBase(ch, agentName);
    case "SOUL.md":
      return buildSoulBase(agentName);
    case "TOOLS.md":
      return buildToolsBase();
  }
}

// ─── Splice + analysis ─────────────────────────────────────────────────────

/**
 * Replace the managed BASE block in `existing` with `baseBody`, preserving any
 * content outside the markers. If no block exists, the base is placed at the
 * top and the prior content kept below it.
 */
function splice(existing: string, baseBody: string): string {
  const block = `${BEGIN}\n${baseBody.trim()}\n${END}`;
  const b = existing.match(BEGIN_RE);
  const e = existing.match(END_RE);
  if (b && e && b.index !== undefined && e.index !== undefined && e.index > b.index) {
    const before = existing.slice(0, b.index).trimEnd();
    const after = existing.slice(e.index + e[0].length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n").trim() + "\n";
  }
  const base = existing.trimEnd();
  return base ? `${block}\n\n${base}\n` : `${block}\n`;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export interface FileAnalysis {
  hasBase: boolean;
  baseChars: number;
  customChars: number;
  totalChars: number;
  tokensEstimate: number;
}

export function analyze(content: string): FileAnalysis {
  const b = content.match(BEGIN_RE);
  const e = content.match(END_RE);
  let baseChars = 0;
  if (b && e && b.index !== undefined && e.index !== undefined && e.index > b.index) {
    baseChars = e.index + e[0].length - b.index;
  }
  const total = content.length;
  return {
    hasBase: baseChars > 0,
    baseChars,
    customChars: Math.max(0, total - baseChars),
    totalChars: total,
    tokensEstimate: estimateTokens(content),
  };
}

// ─── Public API: read / preview / apply ────────────────────────────────────

/**
 * Resolve the on-disk workspace for an agent the same way the OpenClaw gateway
 * does — which is the crux of writing to the file the agent actually reads.
 *
 * openclaw.json stores e.g. `workspace: "./workspace/mission-control"`. The
 * gateway resolves a RELATIVE workspace against its working dir / HOME (e.g.
 * `/root`), NOT against the OpenClaw state dir (`/root/.openclaw`). AtlasDeck's
 * generic `getAgentWorkspacePath` resolves against the state dir, which on this
 * install points at a stale leftover copy. We mirror the gateway's rule here,
 * preferring the home-based path, then falling back to the state-dir path only
 * if the home-based one doesn't exist.
 */
function resolveWorkspaceAbs(agentId: string): string | null {
  let raw: string | undefined;
  try {
    const { path: cfgPath } = resolveOpenClawAgentsConfigPath();
    const parsed = JSON.parse(fsSync.readFileSync(cfgPath, "utf8")) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };
    raw = parsed.agents?.list?.find((a) => a?.id === agentId)?.workspace;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "string") return null;
  if (path.isAbsolute(raw)) return raw;

  const homeBased = path.resolve(os.homedir(), raw);
  const dirBased = path.resolve(getOpenClawDir(), raw);
  if (fsSync.existsSync(homeBased)) return homeBased;
  if (fsSync.existsSync(dirBased)) return dirBased;
  return homeBased; // honor the gateway's rule even before the dir is created
}

export interface InstructionFilePreview {
  file: ManagedInstructionFile;
  before: string;
  after: string;
  changed: boolean;
  exists: boolean;
  analysisBefore: FileAnalysis;
  analysisAfter: FileAnalysis;
}

export interface InstructionPreview {
  agentId: string;
  agentName: string;
  workspace: string;
  channels: ChannelContext;
  files: InstructionFilePreview[];
}

export async function previewInstructions(
  agentId: string,
): Promise<InstructionPreview | null> {
  const wsAbs = resolveWorkspaceAbs(agentId);
  if (!wsAbs) return null;
  const channels = detectChannels();
  const agentName = deriveAgentName(agentId);

  const files: InstructionFilePreview[] = [];
  for (const file of INSTRUCTION_MANAGED_FILES) {
    const full = path.join(wsAbs, file);
    let before = "";
    let exists = false;
    try {
      before = await fs.readFile(full, "utf8");
      exists = true;
    } catch {
      before = "";
    }
    const after = splice(before, buildBase(file, channels, agentName));
    files.push({
      file,
      before,
      after,
      changed: after !== before,
      exists,
      analysisBefore: analyze(before),
      analysisAfter: analyze(after),
    });
  }

  return { agentId, agentName, workspace: wsAbs, channels, files };
}

export interface InstructionApplyResult {
  agentId: string;
  workspace: string;
  backupDir: string | null;
  written: ManagedInstructionFile[];
  channels: ChannelContext;
}

export async function applyInstructions(
  agentId: string,
): Promise<InstructionApplyResult | null> {
  const preview = await previewInstructions(agentId);
  if (!preview) return null;

  const changed = preview.files.filter((f) => f.changed);
  let backupDir: string | null = null;

  if (changed.length) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = path.join(preview.workspace, `.atlasdeck-bak-${ts}`);
    await fs.mkdir(backupDir, { recursive: true });
    for (const f of changed) {
      const dest = path.join(preview.workspace, f.file);
      if (f.exists) {
        try {
          await fs.writeFile(path.join(backupDir, f.file), f.before, "utf8");
        } catch {
          /* best-effort backup */
        }
      }
      await fs.writeFile(dest, f.after, "utf8");
    }
  }

  return {
    agentId,
    workspace: preview.workspace,
    backupDir,
    written: changed.map((f) => f.file),
    channels: preview.channels,
  };
}
