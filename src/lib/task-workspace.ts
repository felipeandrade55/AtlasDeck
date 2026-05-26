/**
 * Per-task workspace isolation.
 *
 * Each delegated task gets its own scratch directory under
 *   <OPENCLAW_DIR>/workspace/tasks/<task_id>/
 * so concurrent sub-agents (Convoy Mode) can write without stomping each
 * other. On approval, the task's outputs can be merged into the assignee's
 * main workspace via mergeTaskWorkspaceInto(); on rejection or cancel, the
 * directory is discarded.
 *
 * We deliberately put this under the OpenClaw workspace dir (not Next's
 * cwd) so the sub-agent — which already operates with the OpenClaw home as
 * its working root — can reach it via a relative path matching what it
 * stores in `task.workspace_path`.
 */
import fs from "fs";
import path from "path";
import { OPENCLAW_DIR } from "./paths";

/**
 * Where to physically allocate task workspaces. In production (VPS) this is
 * `<OPENCLAW_DIR>/workspace/tasks/` so the sub-agent — which runs with the
 * OpenClaw home as its cwd — can reach it via the relative path stored in
 * `task.workspace_path`. In dev (macOS) the configured OPENCLAW_DIR
 * (`/root/.openclaw`) is not writable, so we fall back to `data/task-workspaces/`
 * inside the AtlasDeck project. Same approach as resolveOpenClawAgentsConfigPath().
 */
function resolveTaskWorkspaceRoot(): { absRoot: string; relRoot: string } {
  // Prefer the OpenClaw dir when it exists and is writable.
  if (fs.existsSync(OPENCLAW_DIR)) {
    try {
      fs.accessSync(OPENCLAW_DIR, fs.constants.W_OK);
      return {
        absRoot: path.join(OPENCLAW_DIR, "workspace", "tasks"),
        relRoot: "./workspace/tasks",
      };
    } catch {
      // dir exists but is not writable — fall through to local fallback
    }
  }
  // Local fallback (dev / install before openclaw set up)
  return {
    absRoot: path.join(process.cwd(), "data", "task-workspaces"),
    relRoot: "./data/task-workspaces",
  };
}

const { absRoot: TASKS_ROOT_ABS, relRoot: TASKS_ROOT_REL } = resolveTaskWorkspaceRoot();

export interface TaskWorkspace {
  taskId: string;
  /** Path stored in DB & passed to the sub-agent — relative to OPENCLAW_DIR. */
  relativePath: string;
  /** Absolute path for filesystem operations from AtlasDeck. */
  absolutePath: string;
  created: boolean;
}

export function getTaskWorkspace(taskId: string): TaskWorkspace {
  const relativePath = `${TASKS_ROOT_REL}/${taskId}`;
  const absolutePath = path.join(TASKS_ROOT_ABS, taskId);
  return {
    taskId,
    relativePath,
    absolutePath,
    created: fs.existsSync(absolutePath),
  };
}

export function ensureTaskWorkspace(taskId: string): TaskWorkspace {
  const ws = getTaskWorkspace(taskId);
  if (!ws.created) {
    fs.mkdirSync(ws.absolutePath, { recursive: true });
    // Seed README so the agent can see what's expected when it opens it.
    const readme = path.join(ws.absolutePath, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        `# Task ${taskId}\n\nIsolated workspace for this task. Files written here are\nmerged into the assignee's main workspace on approval, or discarded on\nrejection/cancel.\n`,
        "utf-8",
      );
    }
  }
  return getTaskWorkspace(taskId);
}

export function discardTaskWorkspace(taskId: string): boolean {
  const ws = getTaskWorkspace(taskId);
  if (!ws.created) return false;
  fs.rmSync(ws.absolutePath, { recursive: true, force: true });
  return true;
}

/**
 * Copies files from a task workspace into a target directory (typically
 * the assigned agent's main workspace). Existing files in the target are
 * overwritten — caller is responsible for any conflict-resolution policy
 * before invoking this (e.g. having the reviewer confirm).
 *
 * Skips the workspace's own README.md (it's metadata, not output).
 */
export function mergeTaskWorkspaceInto(taskId: string, targetDirAbs: string): { copied: string[]; skipped: string[] } {
  const ws = getTaskWorkspace(taskId);
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!ws.created) return { copied, skipped };

  fs.mkdirSync(targetDirAbs, { recursive: true });

  function walk(src: string, dest: string) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      // Skip the auto-generated README at the workspace root.
      if (src === ws.absolutePath && entry.name === "README.md") {
        skipped.push(entry.name);
        continue;
      }
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        copied.push(path.relative(ws.absolutePath, srcPath));
      }
    }
  }

  walk(ws.absolutePath, targetDirAbs);
  return { copied, skipped };
}

export function listTaskWorkspaces(): string[] {
  if (!fs.existsSync(TASKS_ROOT_ABS)) return [];
  return fs.readdirSync(TASKS_ROOT_ABS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
