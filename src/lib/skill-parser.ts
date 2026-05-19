import fs from 'fs';
import path from 'path';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  location: string;
  source: 'workspace' | 'system';
  homepage?: string;
  emoji?: string;
  fileCount: number;
  fullContent: string;
  files: string[];
  agents: string[];
  missing?: boolean;
}

interface FrontMatter {
  name?: string;
  description?: string;
  homepage?: string;
  metadata?: {
    openclaw?: {
      emoji?: string;
    };
  };
}

interface ConfiguredSkill {
  name: string;
  location: string;
}

interface SkillsConfig {
  systemSkillsPath?: string;
  workspaceSkillsPath?: string;
  skills: ConfiguredSkill[];
}

const CONFIG_PATH = path.join(process.cwd(), 'data', 'configured-skills.json');
const DEFAULT_SYSTEM_PATH = '/usr/lib/node_modules/openclaw/skills';
const DEFAULT_WORKSPACE_PATH = (process.env.OPENCLAW_DIR || '/root/.openclaw') + '/workspace-infra/skills';

function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!frontMatterMatch) {
    return { frontMatter: {}, body: content };
  }

  const yamlContent = frontMatterMatch[1];
  const body = frontMatterMatch[2];

  const frontMatter: FrontMatter = {};

  const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
  if (nameMatch) frontMatter.name = nameMatch[1].trim();

  const descMatch = yamlContent.match(/^description:\s*(.+)$/m);
  if (descMatch) frontMatter.description = descMatch[1].trim();

  const homepageMatch = yamlContent.match(/^homepage:\s*(.+)$/m);
  if (homepageMatch) frontMatter.homepage = homepageMatch[1].trim();

  const emojiMatch = yamlContent.match(/"emoji":\s*"([^"]+)"/);
  if (emojiMatch) {
    frontMatter.metadata = { openclaw: { emoji: emojiMatch[1] } };
  }

  return { frontMatter, body };
}

function extractFirstParagraph(body: string): string {
  const lines = body.split('\n');
  let inParagraph = false;
  let paragraph = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      if (inParagraph) break;
      continue;
    }

    if (!trimmed && !inParagraph) continue;

    if (trimmed && !inParagraph) {
      inParagraph = true;
      paragraph = trimmed;
      continue;
    }

    if (trimmed && inParagraph) {
      paragraph += ' ' + trimmed;
      continue;
    }

    if (!trimmed && inParagraph) break;
  }

  return paragraph || 'No description available';
}

function countFiles(skillPath: string): { count: number; files: string[] } {
  try {
    const files: string[] = [];

    function scanDir(dir: string, prefix: string = '') {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), relativePath);
        } else {
          files.push(relativePath);
        }
      }
    }

    scanDir(skillPath);
    return { count: files.length, files };
  } catch {
    return { count: 0, files: [] };
  }
}

/**
 * Parse a skill at the given path with an explicit source label.
 */
function parseSkillAtPath(
  skillPath: string,
  skillName: string,
  agents: string[],
  source: 'workspace' | 'system'
): SkillInfo | null {
  const skillMdPath = path.join(skillPath, 'SKILL.md');

  if (!fs.existsSync(skillMdPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const { frontMatter, body } = parseFrontMatter(content);
    const { count, files } = countFiles(skillPath);

    return {
      id: skillName,
      name: frontMatter.name || skillName,
      description: frontMatter.description || extractFirstParagraph(body),
      location: skillPath,
      source,
      homepage: frontMatter.homepage,
      emoji: frontMatter.metadata?.openclaw?.emoji,
      fileCount: count,
      fullContent: content,
      files,
      agents,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a single skill from its directory, inferring source from path.
 */
export function parseSkill(skillPath: string, skillName: string, agents: string[] = []): SkillInfo | null {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const source: 'workspace' | 'system' =
    norm(skillPath).startsWith(norm(DEFAULT_WORKSPACE_PATH)) ? 'workspace' : 'system';
  return parseSkillAtPath(skillPath, skillName, agents, source);
}

/**
 * Build a map of skill-name -> [agentId] by scanning all workspace skill dirs.
 */
function buildAgentSkillMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const openclawDir = process.env.OPENCLAW_DIR || '/root/.openclaw';

  let agentList: Array<{ id: string; workspace: string }> = [];
  try {
    const openclawConfig = JSON.parse(fs.readFileSync(path.join(openclawDir, 'openclaw.json'), 'utf-8'));
    agentList = (openclawConfig?.agents?.list || []).map((a: any) => ({
      id: a.id,
      workspace: a.workspace || path.join(openclawDir, 'workspace'),
    }));
  } catch {
    try {
      const dirs = fs.readdirSync(openclawDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory() && d.name.startsWith('workspace')) {
          const agentId = d.name === 'workspace' ? 'main' : d.name.replace('workspace-', '');
          agentList.push({ id: agentId, workspace: path.join(openclawDir, d.name) });
        }
      }
    } catch {}
  }

  for (const { id, workspace } of agentList) {
    const skillsDir = path.join(workspace, 'skills');
    try {
      if (!fs.existsSync(skillsDir)) continue;
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const d of skillDirs) {
        if (d.isDirectory()) {
          const existing = map.get(d.name) || [];
          existing.push(id);
          map.set(d.name, existing);
        }
      }
    } catch {}
  }

  return map;
}

/**
 * Collect all workspace `skills/` directories by reading openclaw.json
 * or falling back to scanning workspace-* dirs in OPENCLAW_DIR.
 */
function getAllWorkspaceSkillsDirs(openclawDir: string, configOverride?: string): string[] {
  if (configOverride) return [configOverride];

  const dirs: string[] = [];

  // Primary: read agent workspace paths from openclaw.json
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(openclawDir, 'openclaw.json'), 'utf-8'));
    const agentList: Array<{ workspace?: string }> = cfg?.agents?.list || [];
    for (const agent of agentList) {
      if (agent.workspace) {
        const sd = path.join(agent.workspace, 'skills');
        if (!dirs.includes(sd)) dirs.push(sd);
      }
    }
  } catch {}

  // Fallback: scan every workspace-* and workspace dir
  if (dirs.length === 0) {
    try {
      const entries = fs.readdirSync(openclawDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && (e.name === 'workspace' || e.name.startsWith('workspace-'))) {
          const sd = path.join(openclawDir, e.name, 'skills');
          if (!dirs.includes(sd)) dirs.push(sd);
        }
      }
    } catch {}
  }

  // Always ensure workspace-infra/skills is included (standard install location)
  const infra = path.join(openclawDir, 'workspace-infra', 'skills');
  if (!dirs.includes(infra)) dirs.push(infra);

  return dirs;
}

/**
 * Scan all skills: auto-discovers from all workspace skills dirs + system path,
 * then marks configured skills that are missing on disk.
 */
export function scanAllSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seenPaths = new Set<string>();

  let config: SkillsConfig = { skills: [] };
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // Config is optional — proceed with auto-discovery only
  }

  const openclawDir = process.env.OPENCLAW_DIR || '/root/.openclaw';
  const systemPath = config.systemSkillsPath || DEFAULT_SYSTEM_PATH;
  const agentSkillMap = buildAgentSkillMap();

  function discoverInDir(basePath: string, source: 'workspace' | 'system') {
    try {
      if (!fs.existsSync(basePath)) return;
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillPath = path.join(basePath, entry.name);
        if (seenPaths.has(skillPath)) continue;
        seenPaths.add(skillPath);
        const agents = agentSkillMap.get(entry.name) || [];
        const skill = parseSkillAtPath(skillPath, entry.name, agents, source);
        if (skill) skills.push(skill);
      }
    } catch {}
  }

  // 1. Auto-discover system skills
  discoverInDir(systemPath, 'system');

  // 2. Auto-discover workspace skills from ALL workspace-*/skills directories
  const workspaceSkillsDirs = getAllWorkspaceSkillsDirs(openclawDir, config.workspaceSkillsPath);
  for (const wsDir of workspaceSkillsDirs) {
    discoverInDir(wsDir, 'workspace');
  }

  // 3. Add configured skills that weren't auto-discovered (custom absolute paths)
  for (const { name, location } of config.skills) {
    let skillPath: string;
    let configSource: 'workspace' | 'system';

    if (location === 'system') {
      skillPath = path.join(systemPath, name);
      configSource = 'system';
    } else if (location === 'workspace') {
      skillPath = path.join(openclawDir, 'workspace-infra', 'skills', name);
      configSource = 'workspace';
    } else {
      skillPath = location;
      const norm = (p: string) => p.replace(/\\/g, '/');
      configSource = norm(location).includes('workspace') ? 'workspace' : 'system';
    }

    if (seenPaths.has(skillPath)) continue;
    seenPaths.add(skillPath);

    if (!fs.existsSync(skillPath)) {
      skills.push({
        id: name,
        name,
        description: 'Skill configurada mas não instalada no sistema.',
        location: skillPath,
        source: configSource,
        fileCount: 0,
        fullContent: '',
        files: [],
        agents: [],
        missing: true,
      });
      continue;
    }

    const agents = agentSkillMap.get(name) || [];
    const skill = parseSkillAtPath(skillPath, name, agents, configSource);
    if (skill) skills.push(skill);
  }

  // Sort: workspace first, alphabetical; missing at the end
  skills.sort((a, b) => {
    if (!!a.missing !== !!b.missing) return a.missing ? 1 : -1;
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return skills;
}

/**
 * Returns diagnostic info about what paths are being scanned.
 * Useful for debugging missing skills.
 */
export function getSkillsScanInfo(): {
  openclawDir: string;
  systemPath: string;
  workspaceSkillsDirs: string[];
  configPath: string;
  configLoaded: boolean;
  configuredSkills: string[];
} {
  const openclawDir = process.env.OPENCLAW_DIR || '/root/.openclaw';
  let config: SkillsConfig = { skills: [] };
  let configLoaded = false;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    configLoaded = true;
  } catch {}

  return {
    openclawDir,
    systemPath: config.systemSkillsPath || DEFAULT_SYSTEM_PATH,
    workspaceSkillsDirs: getAllWorkspaceSkillsDirs(openclawDir, config.workspaceSkillsPath),
    configPath: CONFIG_PATH,
    configLoaded,
    configuredSkills: config.skills.map((s) => s.name),
  };
}
