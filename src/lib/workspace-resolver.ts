import path from "path";
import { getOpenClawDir } from "./openclaw-config";

/**
 * Resolve a workspace ID to an absolute filesystem path.
 *
 * Supports:
 *   - "workspace"           → <OPENCLAW_DIR>/workspace
 *   - "workspace-<name>"    → <OPENCLAW_DIR>/workspace-<name>
 *   - "mission-control"     → <OPENCLAW_DIR>/workspace/mission-control
 *
 * Resolution honours the saved openclaw-config.json first, then the
 * OPENCLAW_DIR env var, then the default `/root/.openclaw`.
 *
 * Returns null when the workspace id is invalid or the resolved path
 * escapes OPENCLAW_DIR (defense in depth against traversal attempts).
 */
export function resolveWorkspacePath(workspace: string): string | null {
  if (!workspace || typeof workspace !== "string") return null;

  const openclawDir = getOpenClawDir();

  if (workspace === "mission-control") {
    return path.join(openclawDir, "workspace", "mission-control");
  }

  const base = path.join(openclawDir, workspace);

  const resolved = path.resolve(base);
  const openclawResolved = path.resolve(openclawDir);
  if (!resolved.startsWith(openclawResolved)) return null;

  return resolved;
}
