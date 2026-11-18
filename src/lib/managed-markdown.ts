/**
 * Managed sections inside workspace markdown files (MEMORY.md, USER.md…).
 *
 * Several writers touch the same MEMORY.md (auto-recall injector,
 * orchestrator injector, per-agent prompt). Each did its own
 * read → splice → write with no coordination, so two concurrent runs
 * could silently drop each other's block. This module serializes all
 * writes per file (in-process mutex), re-reads inside the lock, and
 * writes atomically (tmp file + rename) so the gateway never reads a
 * half-written file.
 */
import { promises as fs } from "fs";
import path from "path";

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` while holding the lock for `file` (absolute path). */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = previous.catch(() => undefined).then(() => current);
  locks.set(key, chained);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows can refuse rename over an open file; fall back to direct write.
    await fs.writeFile(file, content, "utf-8");
    await fs.unlink(tmp).catch(() => undefined);
    if (process.env.MEMORY_DEBUG === "1") console.warn("[managed-markdown] rename failed:", err);
  }
}

/**
 * Replace (or append, or remove when `block` is null) the text between
 * `begin` and `end` markers. Content outside the markers is preserved.
 * `block` must already include the markers.
 */
export function spliceManagedBlock(
  existing: string,
  begin: string,
  end: string,
  block: string | null,
): string {
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  const hasBlock = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  if (hasBlock) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + end.length).trimStart();
    const parts = block ? [before, block, after] : [before, after];
    return parts.filter(Boolean).join("\n\n").trim() + "\n";
  }
  if (!block) return existing;
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export interface ManagedBlockResult {
  file: string;
  changed: boolean;
  bytes: number;
  content: string;
}

/**
 * Update one managed block in `file`. `render` receives the current file
 * text (read inside the lock) and returns the full block (with markers),
 * or null to remove it. Returns whether the file changed.
 */
export async function updateManagedBlock(
  file: string,
  begin: string,
  end: string,
  render: (existing: string) => string | null | Promise<string | null>,
  opts: { initialContent?: string } = {},
): Promise<ManagedBlockResult> {
  return withFileLock(file, async () => {
    let existing: string;
    try {
      existing = await fs.readFile(file, "utf-8");
    } catch {
      existing = opts.initialContent ?? "";
    }
    const block = await render(existing);
    const next = spliceManagedBlock(existing, begin, end, block);
    if (next === existing) {
      return { file, changed: false, bytes: 0, content: existing };
    }
    await writeFileAtomic(file, next);
    return { file, changed: true, bytes: Buffer.byteLength(next, "utf-8"), content: next };
  });
}

/** Text between markers (exclusive), or null when the block is absent. */
export function readManagedBlock(existing: string, begin: string, end: string): string | null {
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  return existing.slice(beginIdx + begin.length, endIdx);
}

/** Strip a managed block entirely (used by importers so they don't
 *  re-ingest generated text as if the user had written it). */
export function stripManagedBlock(existing: string, begin: string, end: string): string {
  return spliceManagedBlock(existing, begin, end, null);
}
