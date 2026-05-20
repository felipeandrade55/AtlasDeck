/**
 * SQLite FTS5 index over workspace memory markdown files.
 *
 * The markdown files on disk remain the source of truth. This module
 * keeps a SQLite mirror (data/memory-fts.db) so we can do fast
 * full-text search with BM25 scoring, snippet extraction, and
 * Unicode-aware tokenization (handles Portuguese accents).
 *
 * Sync model: callers should invoke `syncWorkspace(workspace)` before
 * a search to catch any out-of-band edits (OpenClaw CLI writes daily
 * snapshots directly to disk). Mutating routes also call `indexFile`
 * / `removeFile` synchronously so changes appear immediately.
 */
import Database from "better-sqlite3";
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import {
  MEMORY_DIR,
  ROOT_FILES,
  extractTitle,
} from "./memory-files";
import { resolveWorkspacePath } from "./workspace-resolver";

const DB_PATH = path.join(process.cwd(), "data", "memory-fts.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.dirname(DB_PATH);
  if (!fsSync.existsSync(dataDir)) {
    fsSync.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      title TEXT,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_memfiles_workspace ON memory_files(workspace);
    CREATE INDEX IF NOT EXISTS idx_memfiles_mtime ON memory_files(mtime_ms DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      workspace UNINDEXED,
      rel_path UNINDEXED,
      title,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  return _db;
}

export interface SearchHit {
  workspace: string;
  file: string;
  title: string;
  snippet: string;
  score: number;
  path: string;
}

interface FtsRow {
  workspace: string;
  rel_path: string;
  title: string;
  snippet: string;
  score: number;
}

interface MemoryFileRow {
  rel_path: string;
  abs_path: string;
  mtime_ms: number;
}

/**
 * Read a file, derive title, and upsert into the FTS5 index.
 * Best-effort: errors are logged and swallowed so callers (mutating
 * routes) don't fail just because the index couldn't be updated.
 */
export async function indexFile(
  workspace: string,
  relPath: string,
  absPath: string,
): Promise<void> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return;
    const content = await fs.readFile(absPath, "utf-8");
    const title = extractTitle(content, path.basename(relPath));

    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO memory_files (workspace, rel_path, abs_path, mtime_ms, size_bytes, title, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(workspace, rel_path) DO UPDATE SET
           abs_path = excluded.abs_path,
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes,
           title = excluded.title,
           indexed_at = datetime('now')`,
      ).run(workspace, relPath, absPath, stat.mtimeMs, stat.size, title);

      db.prepare(
        `DELETE FROM memory_fts WHERE workspace = ? AND rel_path = ?`,
      ).run(workspace, relPath);
      db.prepare(
        `INSERT INTO memory_fts (workspace, rel_path, title, content)
         VALUES (?, ?, ?, ?)`,
      ).run(workspace, relPath, title, content);
    });
    tx();
  } catch (error) {
    console.warn(
      `[memory-fts] indexFile failed for ${workspace}:${relPath}:`,
      error,
    );
  }
}

export function removeFile(workspace: string, relPath: string): void {
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM memory_files WHERE workspace = ? AND rel_path = ?`,
      ).run(workspace, relPath);
      db.prepare(
        `DELETE FROM memory_fts WHERE workspace = ? AND rel_path = ?`,
      ).run(workspace, relPath);
    });
    tx();
  } catch (error) {
    console.warn(
      `[memory-fts] removeFile failed for ${workspace}:${relPath}:`,
      error,
    );
  }
}

async function listWorkspaceFiles(
  workspacePath: string,
): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];

  for (const root of ROOT_FILES) {
    const abs = path.join(workspacePath, root);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) out.push({ rel: root, abs });
    } catch {}
  }

  const memDir = path.join(workspacePath, MEMORY_DIR);
  try {
    const entries = await fs.readdir(memDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const abs = path.join(memDir, entry);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) out.push({ rel: `${MEMORY_DIR}/${entry}`, abs });
      } catch {}
    }
  } catch {}

  return out;
}

/**
 * Incremental sync: for the given workspace, ensure every markdown
 * file present on disk has a fresh row in the FTS index and prune any
 * rows pointing at deleted files.
 *
 * Cheap: only stats files; re-reads/re-indexes only when mtime changes.
 */
export async function syncWorkspace(workspace: string): Promise<void> {
  const wsPath = resolveWorkspacePath(workspace);
  if (!wsPath) return;
  try {
    await fs.access(wsPath);
  } catch {
    return;
  }

  const db = getDb();
  const existing = db
    .prepare(
      `SELECT rel_path, abs_path, mtime_ms FROM memory_files WHERE workspace = ?`,
    )
    .all(workspace) as MemoryFileRow[];
  const existingByRel = new Map<string, MemoryFileRow>(
    existing.map((row) => [row.rel_path, row]),
  );

  const onDisk = await listWorkspaceFiles(wsPath);
  const seen = new Set<string>();

  for (const file of onDisk) {
    seen.add(file.rel);
    const prev = existingByRel.get(file.rel);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(file.abs)).mtimeMs;
    } catch {
      continue;
    }
    if (!prev || prev.mtime_ms !== mtimeMs) {
      await indexFile(workspace, file.rel, file.abs);
    }
  }

  // Prune deleted files
  for (const row of existing) {
    if (!seen.has(row.rel_path)) {
      removeFile(workspace, row.rel_path);
    }
  }
}

/**
 * Walk every workspace under OPENCLAW_DIR and reindex everything.
 * Used by the manual `POST /api/memory/index` endpoint.
 */
export async function rebuildAll(): Promise<{
  workspaces: number;
  files: number;
}> {
  // Lazy import to avoid pulling openclaw-config in cold paths.
  const { getOpenClawDir } = await import("./openclaw-config");
  const openclawDir = getOpenClawDir();

  let workspaces = 0;
  let files = 0;

  try {
    const entries = await fs.readdir(openclawDir, { withFileTypes: true });
    const candidates = ["workspace", ...entries.filter((e) => e.isDirectory() && e.name.startsWith("workspace-")).map((e) => e.name)];

    for (const ws of candidates) {
      const wsPath = path.join(openclawDir, ws);
      try {
        await fs.access(wsPath);
      } catch {
        continue;
      }
      workspaces++;
      const onDisk = await listWorkspaceFiles(wsPath);
      for (const file of onDisk) {
        await indexFile(ws, file.rel, file.abs);
        files++;
      }
    }
  } catch (error) {
    console.warn("[memory-fts] rebuildAll failed:", error);
  }

  return { workspaces, files };
}

/**
 * Escape FTS5 special characters and quote each whitespace-separated
 * term so user input cannot break the MATCH expression. Returns the
 * empty string when no usable tokens remain.
 */
function buildMatchQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((t) => t.length >= 1);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" ");
}

export interface SearchOptions {
  workspace?: string;
  limit?: number;
}

export function searchMemoryFiles(
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const match = buildMatchQuery(query);
  if (!match) return [];

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const db = getDb();

  const conditions: string[] = ["memory_fts MATCH ?"];
  const params: unknown[] = [match];
  if (opts.workspace) {
    conditions.push("workspace = ?");
    params.push(opts.workspace);
  }

  const sql = `
    SELECT
      workspace,
      rel_path,
      title,
      snippet(memory_fts, 3, '«', '»', '...', 16) AS snippet,
      bm25(memory_fts) AS score
    FROM memory_fts
    WHERE ${conditions.join(" AND ")}
    ORDER BY score ASC
    LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as FtsRow[];
    return rows.map((row) => ({
      workspace: row.workspace,
      file: path.basename(row.rel_path),
      title: row.title || path.basename(row.rel_path, ".md"),
      snippet: (row.snippet || "").replace(/\n+/g, " ").trim(),
      score: row.score,
      path: row.rel_path,
    }));
  } catch (error) {
    console.warn("[memory-fts] searchMemoryFiles failed:", error);
    return [];
  }
}

export function getIndexStats(): {
  totalFiles: number;
  byWorkspace: Record<string, number>;
  lastIndexedAt: string | null;
} {
  const db = getDb();
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM memory_files")
    .get() as { n: number };
  const rows = db
    .prepare(
      "SELECT workspace, COUNT(*) AS n FROM memory_files GROUP BY workspace",
    )
    .all() as Array<{ workspace: string; n: number }>;
  const last = db
    .prepare(
      "SELECT indexed_at FROM memory_files ORDER BY indexed_at DESC LIMIT 1",
    )
    .get() as { indexed_at: string } | undefined;

  const byWorkspace: Record<string, number> = {};
  for (const r of rows) byWorkspace[r.workspace] = r.n;

  return {
    totalFiles: total.n,
    byWorkspace,
    lastIndexedAt: last?.indexed_at ?? null,
  };
}
