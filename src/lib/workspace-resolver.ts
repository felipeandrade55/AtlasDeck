import path from "path";

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || "/root/.openclaw";

/**
 * Resolve a workspace ID to an absolute filesystem path.
 * Supports: 'workspace', 'mission-control', and any 'workspace-<name>'.
 */
export function resolveWorkspacePath(workspace: string): string | null {
  if (!workspace || typeof workspace !== "string") return null;

  // Direct mission-control under workspace
  if (workspace === "mission-control") {
    return path.join(OPENCLAW_DIR, "workspace", "mission-control");
  }

  // Any workspace-* or plain workspace
  const base = path.join(OPENCLAW_DIR, workspace);

  // Security: ensure resolved path is still under OPENCLAW_DIR
  const resolved = path.resolve(base);
  const openclawResolved = path.resolve(OPENCLAW_DIR);
  if (!resolved.startsWith(openclawResolved)) return null;

  return resolved;
}
