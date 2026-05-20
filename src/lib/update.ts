/**
 * Update Engine
 * Core logic for the auto-update system — no framework dependencies.
 * Handles config, GitHub comparison, update history, and local version info.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UpdateConfig {
  autoCheck: boolean;
  checkIntervalMinutes: number;
  repoOwner: string;
  repoName: string;
  branch: string;
  backupBeforeUpdate: boolean;
  lastCheckedAt: string | null;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  localSha: string;
  remoteSha: string;
  behindBy: number;
  commits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  checkedAt: string;
}

export interface UpdatePhase {
  name: string;
  status: "pending" | "running" | "ok" | "fail" | "skip";
  startedAt?: string;
  completedAt?: string;
  durationSec?: number;
  error?: string;
}

export interface UpdateHistoryEntry {
  id: string;
  fromSha: string;
  toSha: string;
  status: "success" | "error" | "running";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  backupPath?: string;
  phases: UpdatePhase[];
  error?: string;
}

export interface LocalVersionInfo {
  shaShort: string;
  shaFull: string;
  lastCommitMessage: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: UpdateConfig = {
  autoCheck: true,
  checkIntervalMinutes: 5,
  repoOwner: "felipeandrade55",
  repoName: "AtlasDeck",
  branch: "main",
  backupBeforeUpdate: true,
  lastCheckedAt: null,
};

const MAX_HISTORY_ENTRIES = 20;
const CACHE_TTL_MS = 60_000; // 60 seconds

const GITHUB_USER_AGENT = "AtlasDeck-Update";

// ─── In-memory cache ─────────────────────────────────────────────────────────

let cachedCheckResult: UpdateCheckResult | null = null;
let cachedCheckAt = 0;

// ─── Path helpers ────────────────────────────────────────────────────────────

/** @returns Absolute path to the project root */
function projectRoot(): string {
  return process.cwd();
}

function configFilePath(): string {
  return path.join(projectRoot(), "data", "update-config.json");
}

function historyFilePath(): string {
  return path.join(projectRoot(), "data", "update-history.json");
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Read the update configuration from disk.
 * Returns defaults if the file doesn't exist or is malformed.
 */
export function readUpdateConfig(): UpdateConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<UpdateConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Persist update configuration to disk.
 * Creates the `data/` directory if it doesn't exist.
 */
export function writeUpdateConfig(config: UpdateConfig): void {
  const filePath = configFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────

/** Build headers for GitHub API requests */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": GITHUB_USER_AGENT,
    Accept: "application/vnd.github.v3+json",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Fetch the latest commit SHA on the configured branch from GitHub.
 * @throws on network errors or non-200 responses
 */
async function fetchRemoteSha(
  owner: string,
  repo: string,
  branch: string
): Promise<{ sha: string; message: string; author: string; date: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
  const res = await fetch(url, { headers: githubHeaders() });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API error ${res.status}: ${res.statusText}. ${body}`
    );
  }

  const data = await res.json();
  return {
    sha: data.sha,
    message: data.commit?.message ?? "",
    author: data.commit?.author?.name ?? data.author?.login ?? "unknown",
    date: data.commit?.author?.date ?? new Date().toISOString(),
  };
}

/**
 * Compare two SHAs on GitHub and return the commits between them.
 * Returns an empty array if the SHAs are equal or the compare fails.
 */
async function fetchCommitsBetween(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string
): Promise<
  Array<{ sha: string; message: string; author: string; date: string }>
> {
  if (baseSha === headSha) return [];

  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`;
  const res = await fetch(url, { headers: githubHeaders() });

  if (!res.ok) {
    // Non-critical: if compare fails, we still know there's an update
    console.warn(
      `[update] GitHub compare API returned ${res.status} — commit list unavailable`
    );
    return [];
  }

  const data = await res.json();
  const commits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }> = [];

  if (Array.isArray(data.commits)) {
    for (const c of data.commits) {
      commits.push({
        sha: c.sha,
        message: c.commit?.message ?? "",
        author:
          c.commit?.author?.name ?? c.author?.login ?? "unknown",
        date: c.commit?.author?.date ?? "",
      });
    }
  }

  return commits;
}

// ─── Check for updates ──────────────────────────────────────────────────────

/**
 * Check whether there are new commits on the remote branch.
 * Results are cached in memory for 60 seconds to avoid excessive API calls.
 *
 * @returns UpdateCheckResult with comparison details
 * @throws on git or network errors
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  // Return cached result if still fresh
  if (cachedCheckResult && Date.now() - cachedCheckAt < CACHE_TTL_MS) {
    return cachedCheckResult;
  }

  const config = readUpdateConfig();
  const { repoOwner, repoName, branch } = config;

  // Get local HEAD SHA
  const localSha = getLocalShaFull();

  // Get remote HEAD SHA from GitHub
  const remote = await fetchRemoteSha(repoOwner, repoName, branch);
  const remoteSha = remote.sha;

  // Get list of commits between local and remote
  let commits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }> = [];
  let behindBy = 0;

  if (localSha !== remoteSha) {
    commits = await fetchCommitsBetween(
      repoOwner,
      repoName,
      localSha,
      remoteSha
    );
    behindBy = commits.length;

    // If compare returned no commits but SHAs differ, we're at least 1 behind
    if (behindBy === 0 && localSha !== remoteSha) {
      behindBy = 1;
      commits = [
        {
          sha: remote.sha,
          message: remote.message,
          author: remote.author,
          date: remote.date,
        },
      ];
    }
  }

  const checkedAt = new Date().toISOString();

  // Update lastCheckedAt in config
  config.lastCheckedAt = checkedAt;
  writeUpdateConfig(config);

  const result: UpdateCheckResult = {
    hasUpdate: localSha !== remoteSha,
    localSha,
    remoteSha,
    behindBy,
    commits,
    checkedAt,
  };

  // Cache the result
  cachedCheckResult = result;
  cachedCheckAt = Date.now();

  return result;
}

/**
 * Invalidate the in-memory cache so the next `checkForUpdates` call
 * hits the GitHub API.
 */
export function invalidateCheckCache(): void {
  cachedCheckResult = null;
  cachedCheckAt = 0;
}

// ─── Update History ──────────────────────────────────────────────────────────

/**
 * Read the update history from disk.
 * @returns Array of history entries (newest first), or empty array
 */
export function getUpdateHistory(): UpdateHistoryEntry[] {
  try {
    const raw = fs.readFileSync(historyFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Persist the update history to disk.
 * Enforces a maximum of {@link MAX_HISTORY_ENTRIES} entries.
 */
function writeUpdateHistory(entries: UpdateHistoryEntry[]): void {
  const filePath = historyFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const trimmed = entries.slice(0, MAX_HISTORY_ENTRIES);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
}

/**
 * Add a new history entry (prepended so newest is first).
 * Trims to {@link MAX_HISTORY_ENTRIES}.
 */
export function addUpdateHistoryEntry(entry: UpdateHistoryEntry): void {
  const history = getUpdateHistory();
  history.unshift(entry);
  writeUpdateHistory(history);
}

/**
 * Partially update an existing history entry by ID.
 * Merges `partial` into the existing entry, with special handling for `phases`
 * (replaces the entire phases array if provided).
 *
 * @returns true if the entry was found and updated
 */
export function updateHistoryEntry(
  id: string,
  partial: Partial<UpdateHistoryEntry>
): boolean {
  const history = getUpdateHistory();
  const idx = history.findIndex((e) => e.id === id);
  if (idx === -1) return false;

  history[idx] = { ...history[idx], ...partial };
  writeUpdateHistory(history);
  return true;
}

// ─── Running state ───────────────────────────────────────────────────────────

/**
 * Check whether an update is currently in progress.
 * Looks for any history entry with status 'running'.
 */
export function isUpdateRunning(): boolean {
  const history = getUpdateHistory();
  return history.some((e) => e.status === "running");
}

// ─── Local version info ─────────────────────────────────────────────────────

/**
 * Get the full local HEAD SHA via `git rev-parse HEAD`.
 * @throws if the project root is not a git repository
 */
function getLocalShaFull(): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot(),
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (err) {
    throw new Error(
      `Failed to get local git SHA: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Get local version info: short SHA, full SHA, and the last commit message.
 */
export function getLocalVersion(): LocalVersionInfo {
  const shaFull = getLocalShaFull();

  let shaShort: string;
  try {
    shaShort = execSync("git rev-parse --short HEAD", {
      cwd: projectRoot(),
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    shaShort = shaFull.substring(0, 7);
  }

  let lastCommitMessage: string;
  try {
    lastCommitMessage = execSync("git log -1 --pretty=%B", {
      cwd: projectRoot(),
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    lastCommitMessage = "";
  }

  return { shaShort, shaFull, lastCommitMessage };
}
