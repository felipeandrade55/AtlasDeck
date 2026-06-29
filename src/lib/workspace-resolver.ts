import path from "path";
import os from "os";
import { getOpenClawDir } from "./openclaw-config";

/**
 * Resolve a workspace ID to an absolute filesystem path.
 *
 * Supports:
 *   - "workspace"           → <OPENCLAW_DIR>/workspace
 *   - "workspace-<name>"    → <OPENCLAW_DIR>/workspace-<name>
 *   - "mission-control"     → <OPENCLAW_DIR>/workspace/mission-control
 *   - an ALREADY-absolute path (the setup status reports the workspace as
 *     an absolute path, e.g. "/root/.openclaw/workspace/mission-control")
 *
 * Resolution honours the saved openclaw-config.json first, then the
 * OPENCLAW_DIR env var, then the default `/root/.openclaw`.
 *
 * Returns null when the workspace id is invalid or the resolved path
 * escapes OPENCLAW_DIR / HOME (defense in depth against traversal attempts).
 */
export function resolveWorkspacePath(workspace: string): string | null {
  if (!workspace || typeof workspace !== "string") return null;

  const openclawDir = getOpenClawDir();
  const openclawResolved = path.resolve(openclawDir);

  // Absolute path already given. Accept it as-is when it stays inside
  // OPENCLAW_DIR or HOME — do NOT re-join under openclawDir, which would
  // double the prefix (/root/.openclaw/root/.openclaw/...) and point at a
  // directory that never exists ("Workspace não encontrado no disco").
  if (path.isAbsolute(workspace)) {
    const resolved = path.resolve(workspace);
    const homeResolved = path.resolve(os.homedir());
    if (resolved.startsWith(openclawResolved) || resolved.startsWith(homeResolved)) {
      return resolved;
    }
    return null;
  }

  if (workspace === "mission-control") {
    return path.join(openclawDir, "workspace", "mission-control");
  }

  const resolved = path.resolve(path.join(openclawDir, workspace));
  if (!resolved.startsWith(openclawResolved)) return null;

  return resolved;
}
