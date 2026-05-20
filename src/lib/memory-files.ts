/**
 * Centralized constants and helpers for memory-related files.
 *
 * The workspace memory layout (one per agent) is:
 *   <workspace>/
 *     MEMORY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md,
 *     IDENTITY.md, HEARTBEAT.md       <-- ROOT_FILES
 *     memory/
 *       YYYY-MM-DD.md                 <-- daily snapshots
 *       *.md                          <-- ad-hoc reports / notes
 */
import path from "path";

export const ROOT_FILES = [
  "MEMORY.md",
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
] as const;

export type RootFile = (typeof ROOT_FILES)[number];

export const MEMORY_DIR = "memory";

export const PROTECTED_FILES = [
  ...ROOT_FILES,
  "package.json",
  "tsconfig.json",
  ".env",
  ".env.local",
] as const;

/**
 * Validate and normalize a workspace-relative file path.
 * Returns the normalized relative path or null when unsafe.
 *
 * Allowed locations:
 *   - any ROOT_FILE at the workspace root
 *   - any *.md inside the workspace `memory/` directory
 */
export function sanitizeWorkspaceRelativePath(rel: string): string | null {
  if (typeof rel !== "string") return null;
  const trimmed = rel.trim();
  if (!trimmed) return null;

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));

  if (
    normalized.startsWith("..") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    return null;
  }

  if (!normalized.endsWith(".md")) return null;

  const isRootFile = (ROOT_FILES as readonly string[]).includes(normalized);
  const isMemoryFile = normalized.startsWith(`${MEMORY_DIR}/`);

  if (!isRootFile && !isMemoryFile) return null;

  return normalized;
}

/**
 * First H1 markdown heading, falling back to the basename without extension.
 */
export function extractTitle(content: string, fallbackName: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match && match[1]) return match[1].trim();
  return fallbackName.replace(/\.md$/i, "");
}
