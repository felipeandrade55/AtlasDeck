import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DirectoryEntry {
  name: string;
  path: string;
  readable: boolean;
  hasOpenClawConfig: boolean;
  hasAgentsDir: boolean;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "proc",
  "sys",
  "dev",
  "run",
  "tmp",
  "var/cache",
]);

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function hasOpenClawMarkers(dirPath: string): boolean {
  return fileExists(path.join(dirPath, "openclaw.json")) || fileExists(path.join(dirPath, "agents"));
}

function defaultRoots(): string[] {
  const config = readOpenClawConfig();
  const roots = new Set<string>([
    config.openclawDir,
    path.dirname(config.openclawDir),
    "/root",
    "/home",
    "/opt",
    "/srv",
    process.cwd(),
  ]);

  if (process.platform === "win32") {
    roots.add(os.homedir());
    roots.add("C:\\");
    roots.add("D:\\");
  }

  return [...roots].filter(Boolean);
}

function toEntry(dirPath: string, name?: string): DirectoryEntry {
  return {
    name: name || path.basename(dirPath) || dirPath,
    path: dirPath,
    readable: isDirectory(dirPath),
    hasOpenClawConfig: fileExists(path.join(dirPath, "openclaw.json")),
    hasAgentsDir: fileExists(path.join(dirPath, "agents")),
  };
}

function shouldSkip(childPath: string): boolean {
  const normalized = childPath.replace(/\\/g, "/");
  const base = path.basename(childPath);
  return SKIP_DIRS.has(base) || [...SKIP_DIRS].some((skip) => normalized.endsWith(`/${skip}`));
}

function browseDirectory(dirPath: string) {
  if (!isDirectory(dirPath)) {
    return jsonNoStore(
      { error: "Diretorio nao encontrado", path: dirPath, roots: defaultRoots() },
      { status: 404 }
    );
  }

  const entries: DirectoryEntry[] = [];
  let error: string | null = null;

  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childPath = path.join(dirPath, entry.name);
      entries.push(toEntry(childPath, entry.name));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  entries.sort((a, b) => {
    const aScore = a.hasOpenClawConfig || a.hasAgentsDir ? 0 : 1;
    const bScore = b.hasOpenClawConfig || b.hasAgentsDir ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.name.localeCompare(b.name);
  });

  return jsonNoStore({
    currentPath: dirPath,
    parentPath: path.dirname(dirPath),
    current: toEntry(dirPath),
    entries,
    roots: defaultRoots(),
    error,
  });
}

function searchDirectories(root: string, maxDepth: number) {
  const results: DirectoryEntry[] = [];
  const visited = new Set<string>();
  let scanned = 0;
  const limit = 4000;

  const walk = (dirPath: string, depth: number) => {
    if (results.length >= 60 || scanned >= limit || depth < 0 || !isDirectory(dirPath)) return;

    let realPath = dirPath;
    try {
      realPath = fs.realpathSync(dirPath);
    } catch {
      return;
    }

    if (visited.has(realPath) || shouldSkip(realPath)) return;
    visited.add(realPath);
    scanned += 1;

    if (hasOpenClawMarkers(realPath) || path.basename(realPath) === ".openclaw") {
      results.push(toEntry(realPath));
    }

    if (depth === 0) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(realPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(path.join(realPath, entry.name), depth - 1);
    }
  };

  walk(root, maxDepth);

  results.sort((a, b) => {
    const aScore = a.hasOpenClawConfig ? 0 : a.hasAgentsDir ? 1 : 2;
    const bScore = b.hasOpenClawConfig ? 0 : b.hasAgentsDir ? 1 : 2;
    if (aScore !== bScore) return aScore - bScore;
    return a.path.localeCompare(b.path);
  });

  return jsonNoStore({
    root,
    maxDepth,
    scanned,
    results,
    roots: defaultRoots(),
  });
}

export async function GET(request: NextRequest) {
  const config = readOpenClawConfig();
  const search = request.nextUrl.searchParams.get("search") === "1";
  const requestedPath = request.nextUrl.searchParams.get("path") || config.openclawDir;

  if (search) {
    const depth = Number(request.nextUrl.searchParams.get("depth") || 4);
    return searchDirectories(requestedPath, Math.min(Math.max(depth, 1), 6));
  }

  return browseDirectory(requestedPath);
}
