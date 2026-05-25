/**
 * Workspace migration helpers — list orphan OpenClaw agent workspaces and
 * copy their contents into another agent's workspace.
 *
 * Use case: after the long debugging session we put the user through, the
 * agent ended up with a fresh empty `./workspace/main` while the original
 * memory/skills/sessions still lived in `./workspace/mission-control` (the
 * legacy default). This lets them migrate via 1-click instead of mexing
 * com SSH e cp.
 *
 * Safety:
 *  - Operates only inside `${OPENCLAW_DIR}/workspace` — refuses absolute
 *    paths or paths that escape via `..`
 *  - Default copy mode is "skip existing" (no overwrite). Caller can opt
 *    into overwrite explicitly.
 */
import fs from "fs";
import path from "path";
import { OPENCLAW_DIR } from "./paths";

const WORKSPACE_ROOT = path.join(OPENCLAW_DIR, "workspace");

export interface WorkspaceStats {
  exists: boolean;
  totalFiles: number;
  totalBytes: number;
  /** Top-level subdirectories present (memory, skills, sessions, etc.) */
  topDirs: string[];
  /** Quick flags for the common high-value buckets */
  hasMemory: boolean;
  hasSkills: boolean;
  hasSessions: boolean;
  hasAuth: boolean;
  /** ISO timestamp of the most recently modified file in the tree, if any */
  lastModified: string | null;
}

export interface WorkspaceInfo {
  /** Relative path as it appears in agent.workspace (e.g. "./workspace/main") */
  relativePath: string;
  /** Absolute resolved path */
  absolutePath: string;
  /** Folder name only (e.g. "main", "mission-control") */
  folderName: string;
  /** Which agent currently uses this workspace, if any */
  ownerAgentId: string | null;
  stats: WorkspaceStats;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function walkStats(dir: string): { files: number; bytes: number; latestMtime: number } {
  let files = 0;
  let bytes = 0;
  let latestMtime = 0;

  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        files += 1;
        try {
          const st = fs.statSync(full);
          bytes += st.size;
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {
          // ignore
        }
      }
    }
  }
  return { files, bytes, latestMtime };
}

export function getWorkspaceStats(absolutePath: string): WorkspaceStats {
  if (!safeStat(absolutePath)?.isDirectory()) {
    return {
      exists: false,
      totalFiles: 0,
      totalBytes: 0,
      topDirs: [],
      hasMemory: false,
      hasSkills: false,
      hasSessions: false,
      hasAuth: false,
      lastModified: null,
    };
  }
  let topDirs: string[] = [];
  try {
    topDirs = fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    topDirs = [];
  }
  const { files, bytes, latestMtime } = walkStats(absolutePath);
  const lower = new Set(topDirs.map((d) => d.toLowerCase()));
  return {
    exists: true,
    totalFiles: files,
    totalBytes: bytes,
    topDirs,
    hasMemory: lower.has("memory") || lower.has("memories"),
    hasSkills: lower.has("skills"),
    hasSessions: lower.has("sessions"),
    hasAuth: lower.has("auth") || lower.has("auth-state"),
    lastModified: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
  };
}

/** Resolves an agent.workspace string to an absolute path under OPENCLAW_DIR. */
export function resolveWorkspacePath(workspace: string): string {
  if (path.isAbsolute(workspace)) return workspace;
  return path.resolve(OPENCLAW_DIR, workspace);
}

/**
 * Lists all workspace folders found under `${OPENCLAW_DIR}/workspace`,
 * annotated with stats and which agent (if any) currently uses them.
 * `agentsList` is the agents.list array from openclaw.json.
 */
export function listOpenclawWorkspaces(
  agentsList: Array<{ id?: string; workspace?: string }>,
): WorkspaceInfo[] {
  if (!safeStat(WORKSPACE_ROOT)?.isDirectory()) return [];

  // Build a map: absolute workspace path → agent id that owns it
  const ownerByAbsPath = new Map<string, string>();
  for (const a of agentsList || []) {
    if (typeof a.id === "string" && typeof a.workspace === "string") {
      const abs = resolveWorkspacePath(a.workspace);
      ownerByAbsPath.set(abs, a.id);
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: WorkspaceInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folderName = e.name;
    const absolutePath = path.join(WORKSPACE_ROOT, folderName);
    const relativePath = `./workspace/${folderName}`;
    out.push({
      folderName,
      absolutePath,
      relativePath,
      ownerAgentId: ownerByAbsPath.get(absolutePath) || null,
      stats: getWorkspaceStats(absolutePath),
    });
  }
  return out.sort((a, b) => b.stats.totalFiles - a.stats.totalFiles);
}

export interface ImportResult {
  filesCopied: number;
  filesSkipped: number;
  bytesCopied: number;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Recursively copies all files from `sourceAbs` into `targetAbs`. By default
 * existing files at the destination are preserved (skip mode); pass
 * `overwrite: true` to clobber.
 *
 * Refuses to operate outside `${OPENCLAW_DIR}/workspace` for safety.
 */
export function importWorkspace(
  sourceAbs: string,
  targetAbs: string,
  opts: { overwrite?: boolean } = {},
): ImportResult {
  const result: ImportResult = { filesCopied: 0, filesSkipped: 0, bytesCopied: 0, errors: [] };

  // Safety guards
  const root = WORKSPACE_ROOT + path.sep;
  if (!(`${sourceAbs}${path.sep}`).startsWith(root) || !(`${targetAbs}${path.sep}`).startsWith(root)) {
    throw new Error(`Caminho fora de ${WORKSPACE_ROOT}: source=${sourceAbs} target=${targetAbs}`);
  }
  if (sourceAbs === targetAbs) {
    throw new Error("Source e target apontam pra mesma workspace");
  }
  if (!safeStat(sourceAbs)?.isDirectory()) {
    throw new Error(`Workspace de origem não existe: ${sourceAbs}`);
  }
  // Ensure target exists
  try {
    fs.mkdirSync(targetAbs, { recursive: true });
  } catch (e) {
    throw new Error(`Falha ao criar workspace destino: ${(e as Error).message}`);
  }

  const stack: Array<{ from: string; to: string }> = [{ from: sourceAbs, to: targetAbs }];
  while (stack.length) {
    const { from, to } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch (e) {
      result.errors.push({ path: from, message: (e as Error).message });
      continue;
    }
    for (const e of entries) {
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      if (e.isDirectory()) {
        try {
          fs.mkdirSync(dst, { recursive: true });
        } catch (err) {
          result.errors.push({ path: dst, message: (err as Error).message });
          continue;
        }
        stack.push({ from: src, to: dst });
      } else if (e.isFile()) {
        const exists = fs.existsSync(dst);
        if (exists && !opts.overwrite) {
          result.filesSkipped += 1;
          continue;
        }
        try {
          fs.copyFileSync(src, dst);
          const st = fs.statSync(dst);
          result.filesCopied += 1;
          result.bytesCopied += st.size;
        } catch (err) {
          result.errors.push({ path: src, message: (err as Error).message });
        }
      }
      // ignore symlinks/other for safety
    }
  }

  return result;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
