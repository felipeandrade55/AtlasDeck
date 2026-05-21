/**
 * Idempotent installer for the OpenClaw ↔ AtlasDeck calendar integration.
 *
 * Each step has a checker (returns ok/missing/error + detail) and a runner
 * (executes only what's missing). The same module is used by:
 *   - POST /api/calendar/install (web button)
 *   - scripts/setup-calendar.mjs (standalone CLI)
 *
 * All filesystem writes use atomic patterns (write tmp + rename) to avoid
 * corrupting existing files on partial failures.
 */

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import {
  AGENTS_MD_SKILL_ENTRY,
  SKILL_MD_TEMPLATE,
  SKILL_NAME,
} from "./calendar-installer-templates";
import { isCalendarSchedulerStarted, startCalendarScheduler } from "./calendar-scheduler";

export type StepStatus = "ok" | "missing" | "error" | "skipped";

export interface StepResult {
  key: string;
  label: string;
  status: StepStatus;
  detail: string;
  /** Whether the step requires the OpenClaw filesystem (skipped in cloud/managed). */
  requires_filesystem?: boolean;
}

export interface InstallReport {
  ready: boolean;
  steps: StepResult[];
  generated_at: string;
  base_url: string;
  openclaw_dir: string;
}

export interface InstallerConfig {
  openclawDir: string;
  baseUrl: string;
  envFilePath: string;
}

export function resolveConfig(overrides: Partial<InstallerConfig> = {}): InstallerConfig {
  const openclawDir = overrides.openclawDir ?? process.env.OPENCLAW_DIR ?? "/root/.openclaw";
  const baseUrl =
    overrides.baseUrl ??
    process.env.ATLASDECK_BASE_URL ??
    process.env.NEXTAUTH_URL ??
    "http://localhost:3000";
  const envFilePath = overrides.envFilePath ?? path.join(process.cwd(), ".env.local");
  return { openclawDir, baseUrl, envFilePath };
}

function readJsonSafe<T = unknown>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(target: string, content: string): void {
  const dir = path.dirname(target);
  if (!pathExists(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

function listWorkspaceAgentMdPaths(openclawDir: string): string[] {
  if (!pathExists(openclawDir)) return [];
  const entries = fs.readdirSync(openclawDir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("workspace")) continue;
    const candidate = path.join(openclawDir, entry.name, "AGENTS.md");
    if (pathExists(candidate)) paths.push(candidate);
  }
  return paths;
}

function getServiceToken(openclawDir: string, envFilePath: string): {
  token: string;
  source: "env" | "openclaw.json" | "env_file" | "generated";
  fileToUpdate?: string;
} {
  if (process.env.OPENCLAW_SERVICE_TOKEN) {
    return { token: process.env.OPENCLAW_SERVICE_TOKEN, source: "env" };
  }
  const openclawConfig = readJsonSafe<{
    gateway?: { auth?: { token?: string } };
  }>(path.join(openclawDir, "openclaw.json"));
  if (openclawConfig?.gateway?.auth?.token) {
    return { token: openclawConfig.gateway.auth.token, source: "openclaw.json" };
  }
  if (pathExists(envFilePath)) {
    const content = fs.readFileSync(envFilePath, "utf-8");
    const match = content.match(/^OPENCLAW_SERVICE_TOKEN\s*=\s*(.+)$/m);
    if (match && match[1]) {
      return { token: match[1].trim().replace(/^["']|["']$/g, ""), source: "env_file" };
    }
  }
  return { token: randomBytes(32).toString("hex"), source: "generated", fileToUpdate: envFilePath };
}

/* ─────────────────────────  checkers  ───────────────────────── */

function checkSkillFile(config: InstallerConfig): StepResult {
  const target = path.join(config.openclawDir, "workspace-infra", "skills", SKILL_NAME, "SKILL.md");
  if (!pathExists(config.openclawDir)) {
    return {
      key: "skill_file",
      label: "Skill atlasdeck-calendar instalada",
      status: "error",
      detail: `OpenClaw não encontrado em ${config.openclawDir}. Configure OPENCLAW_DIR ou instale o OpenClaw primeiro.`,
      requires_filesystem: true,
    };
  }
  if (!pathExists(target)) {
    return {
      key: "skill_file",
      label: "Skill atlasdeck-calendar instalada",
      status: "missing",
      detail: `Falta criar ${target}`,
      requires_filesystem: true,
    };
  }
  const content = fs.readFileSync(target, "utf-8");
  if (!content.includes(`name: ${SKILL_NAME}`)) {
    return {
      key: "skill_file",
      label: "Skill atlasdeck-calendar instalada",
      status: "missing",
      detail: "SKILL.md existe mas sem front-matter válido — será sobrescrito",
      requires_filesystem: true,
    };
  }
  return {
    key: "skill_file",
    label: "Skill atlasdeck-calendar instalada",
    status: "ok",
    detail: target,
    requires_filesystem: true,
  };
}

function checkAgentsMd(config: InstallerConfig): StepResult {
  const paths = listWorkspaceAgentMdPaths(config.openclawDir);
  if (paths.length === 0) {
    return {
      key: "agents_md",
      label: "AGENTS.md referencia a skill",
      status: "missing",
      detail: "Nenhum AGENTS.md de workspace encontrado",
      requires_filesystem: true,
    };
  }
  const missing = paths.filter((p) => {
    const txt = fs.readFileSync(p, "utf-8");
    return !txt.includes(AGENTS_MD_SKILL_ENTRY);
  });
  if (missing.length > 0) {
    return {
      key: "agents_md",
      label: "AGENTS.md referencia a skill",
      status: "missing",
      detail: `Falta adicionar em: ${missing.map((p) => path.relative(config.openclawDir, p)).join(", ")}`,
      requires_filesystem: true,
    };
  }
  return {
    key: "agents_md",
    label: "AGENTS.md referencia a skill",
    status: "ok",
    detail: `${paths.length} workspace(s)`,
    requires_filesystem: true,
  };
}

function checkServiceToken(config: InstallerConfig): StepResult {
  const info = getServiceToken(config.openclawDir, config.envFilePath);
  if (info.source === "generated") {
    return {
      key: "service_token",
      label: "OPENCLAW_SERVICE_TOKEN configurado",
      status: "missing",
      detail: "Token será gerado e gravado em .env.local",
    };
  }
  return {
    key: "service_token",
    label: "OPENCLAW_SERVICE_TOKEN configurado",
    status: "ok",
    detail: `via ${info.source}`,
  };
}

function checkScheduler(): StepResult {
  const running = isCalendarSchedulerStarted();
  return {
    key: "scheduler",
    label: "Agendador interno (lembretes + booking + briefing)",
    status: running ? "ok" : "missing",
    detail: running
      ? "Disparando reminders 1min, nudge 30min, briefing 07:00"
      : "Será iniciado ao executar a instalação",
  };
}

function ensureSchedulerRunning(): StepResult {
  startCalendarScheduler();
  return {
    key: "scheduler",
    label: "Agendador interno (lembretes + booking + briefing)",
    status: "ok",
    detail: "Reminders 1min · nudge 30min · briefing 07:00 (TZ do usuário)",
  };
}

/* ─────────────────────────  runners  ───────────────────────── */

function writeSkillFile(config: InstallerConfig): StepResult {
  const target = path.join(config.openclawDir, "workspace-infra", "skills", SKILL_NAME, "SKILL.md");
  try {
    if (!pathExists(config.openclawDir)) {
      return {
        key: "skill_file",
        label: "Skill atlasdeck-calendar instalada",
        status: "error",
        detail: `OPENCLAW_DIR ${config.openclawDir} não existe`,
        requires_filesystem: true,
      };
    }
    atomicWrite(target, SKILL_MD_TEMPLATE);
    return {
      key: "skill_file",
      label: "Skill atlasdeck-calendar instalada",
      status: "ok",
      detail: `Gravado em ${target}`,
      requires_filesystem: true,
    };
  } catch (err) {
    return {
      key: "skill_file",
      label: "Skill atlasdeck-calendar instalada",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
      requires_filesystem: true,
    };
  }
}

function addSkillToAgentsMd(content: string): string {
  if (content.includes(AGENTS_MD_SKILL_ENTRY)) return content;

  if (content.match(/<available_skills>[\s\S]*?<\/available_skills>/)) {
    return content.replace(
      /<available_skills>([\s\S]*?)<\/available_skills>/,
      (_full, inner: string) => {
        const trimmed = inner.replace(/\s+$/, "");
        const sep = trimmed ? "\n" : "";
        return `<available_skills>${trimmed}${sep}${AGENTS_MD_SKILL_ENTRY}\n</available_skills>`;
      }
    );
  }

  const block = `\n\n<available_skills>\n${AGENTS_MD_SKILL_ENTRY}\n</available_skills>\n`;
  return content.replace(/\s*$/, block);
}

function updateAgentsMd(config: InstallerConfig): StepResult {
  try {
    const paths = listWorkspaceAgentMdPaths(config.openclawDir);
    if (paths.length === 0) {
      return {
        key: "agents_md",
        label: "AGENTS.md referencia a skill",
        status: "error",
        detail: "Nenhum AGENTS.md de workspace encontrado",
        requires_filesystem: true,
      };
    }
    const updated: string[] = [];
    for (const p of paths) {
      const original = fs.readFileSync(p, "utf-8");
      const next = addSkillToAgentsMd(original);
      if (next !== original) {
        atomicWrite(p, next);
        updated.push(path.relative(config.openclawDir, p));
      }
    }
    return {
      key: "agents_md",
      label: "AGENTS.md referencia a skill",
      status: "ok",
      detail: updated.length ? `Atualizado: ${updated.join(", ")}` : "Já estava atualizado",
      requires_filesystem: true,
    };
  } catch (err) {
    return {
      key: "agents_md",
      label: "AGENTS.md referencia a skill",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
      requires_filesystem: true,
    };
  }
}

function ensureServiceToken(config: InstallerConfig): StepResult {
  try {
    const info = getServiceToken(config.openclawDir, config.envFilePath);
    if (info.source !== "generated") {
      return {
        key: "service_token",
        label: "OPENCLAW_SERVICE_TOKEN configurado",
        status: "ok",
        detail: `Carregado de ${info.source}`,
      };
    }
    let content = "";
    if (pathExists(config.envFilePath)) {
      content = fs.readFileSync(config.envFilePath, "utf-8");
      content = content.replace(/^OPENCLAW_SERVICE_TOKEN\s*=.*$/m, "").replace(/\n{3,}/g, "\n\n");
    }
    if (content && !content.endsWith("\n")) content += "\n";
    content += `OPENCLAW_SERVICE_TOKEN=${info.token}\n`;
    atomicWrite(config.envFilePath, content);
    return {
      key: "service_token",
      label: "OPENCLAW_SERVICE_TOKEN configurado",
      status: "ok",
      detail: `Token gerado e gravado em ${path.relative(process.cwd(), config.envFilePath)}. Reinicie o AtlasDeck para aplicar.`,
    };
  } catch (err) {
    return {
      key: "service_token",
      label: "OPENCLAW_SERVICE_TOKEN configurado",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ─────────────────────────  public API  ───────────────────────── */

export function getInstallStatus(overrides: Partial<InstallerConfig> = {}): InstallReport {
  const config = resolveConfig(overrides);
  const steps: StepResult[] = [
    checkSkillFile(config),
    checkAgentsMd(config),
    checkServiceToken(config),
    checkScheduler(),
  ];
  return {
    ready: steps.every((s) => s.status === "ok"),
    steps,
    generated_at: new Date().toISOString(),
    base_url: config.baseUrl,
    openclaw_dir: config.openclawDir,
  };
}

export function runInstall(overrides: Partial<InstallerConfig> = {}): InstallReport {
  const config = resolveConfig(overrides);

  const steps: StepResult[] = [
    writeSkillFile(config),
    updateAgentsMd(config),
    ensureServiceToken(config),
    ensureSchedulerRunning(),
  ];

  return {
    ready: steps.every((s) => s.status === "ok"),
    steps,
    generated_at: new Date().toISOString(),
    base_url: config.baseUrl,
    openclaw_dir: config.openclawDir,
  };
}
