import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { runBackup } from "./backup";

const execFileAsync = promisify(execFile);

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
  name: string; // backup, git-pull, npm-install, build, pm2-restart, health-check
  status: 'pending' | 'running' | 'ok' | 'fail' | 'skip';
  startedAt?: string;
  completedAt?: string;
  durationSec?: number;
  error?: string;
}

export interface UpdateHistoryEntry {
  id: string;
  fromSha: string;
  toSha: string;
  status: 'success' | 'error' | 'running';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  backupPath?: string;
  phases: UpdatePhase[];
  error?: string;
  logs?: string;
}

const DEFAULT_CONFIG: UpdateConfig = {
  autoCheck: true,
  checkIntervalMinutes: 5,
  repoOwner: "felipeandrade55",
  repoName: "AtlasDeck",
  branch: "main",
  backupBeforeUpdate: true,
  lastCheckedAt: null,
};

function configPath(): string {
  return path.join(process.cwd(), "data", "update-config.json");
}

function historyPath(): string {
  return path.join(process.cwd(), "data", "update-history.json");
}

export function readUpdateConfig(): UpdateConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeUpdateConfig(config: Partial<UpdateConfig>): UpdateConfig {
  const current = readUpdateConfig();
  const updated = { ...current, ...config };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export function getUpdateHistory(): { updates: UpdateHistoryEntry[] } {
  try {
    const raw = fs.readFileSync(historyPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { updates: [] };
  }
}

export function addUpdateHistoryEntry(entry: UpdateHistoryEntry) {
  const history = getUpdateHistory();
  history.updates.unshift(entry);
  if (history.updates.length > 20) {
    history.updates = history.updates.slice(0, 20);
  }
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
  fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2), "utf-8");
}

export function updateHistoryEntry(id: string, partial: Partial<UpdateHistoryEntry>) {
  const history = getUpdateHistory();
  const index = history.updates.findIndex(e => e.id === id);
  if (index !== -1) {
    history.updates[index] = { ...history.updates[index], ...partial };
    fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2), "utf-8");
  }
}

export function isUpdateRunning(): boolean {
  const history = getUpdateHistory();
  return history.updates.some(e => e.status === "running");
}

let checkCache: { result: UpdateCheckResult, timestamp: number } | null = null;

export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  if (!force && checkCache && Date.now() - checkCache.timestamp < 60000) {
    return checkCache.result;
  }

  const config = readUpdateConfig();
  const headers: Record<string, string> = {
    "User-Agent": "AtlasDeck-Update",
    "Accept": "application/vnd.github.v3+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    // Get local SHA
    let localSha = "";
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
      localSha = stdout.trim();
    } catch (e) {
      console.warn("Could not get local git SHA. Is git installed and is this a git repo?", e);
      // fallback so we don't crash, but update checking won't work well
    }

    if (!localSha) {
        throw new Error("Could not determine local git version.");
    }

    // Get remote branch info
    const branchRes = await fetch(`https://api.github.com/repos/${config.repoOwner}/${config.repoName}/commits/${config.branch}`, { headers });
    if (!branchRes.ok) {
        const text = await branchRes.text();
        throw new Error(`GitHub API error (${branchRes.status}): ${text}`);
    }
    const branchData = await branchRes.json();
    const remoteSha = branchData.sha;

    let hasUpdate = false;
    let behindBy = 0;
    const commits = [];

    if (localSha !== remoteSha) {
      // Compare
      const compareRes = await fetch(`https://api.github.com/repos/${config.repoOwner}/${config.repoName}/compare/${localSha}...${remoteSha}`, { headers });
      if (compareRes.ok) {
        const compareData = await compareRes.json();
        if (compareData.status === "ahead" || compareData.status === "diverged" || compareData.behind_by > 0) {
            hasUpdate = compareData.behind_by > 0 || compareData.commits.length > 0;
            behindBy = compareData.behind_by || compareData.commits.length; // fallback
            
            for (const commit of compareData.commits.reverse()) { // newest first
                commits.push({
                    sha: commit.sha,
                    message: commit.commit.message.split('\n')[0], // first line
                    author: commit.commit.author.name,
                    date: commit.commit.author.date,
                });
            }
        }
      } else {
          // If compare fails (e.g. force push history rewrite), we just know they are different
          hasUpdate = true;
          commits.push({
              sha: remoteSha,
              message: branchData.commit.message.split('\n')[0],
              author: branchData.commit.author.name,
              date: branchData.commit.author.date,
          });
      }
    }

    const result: UpdateCheckResult = {
      hasUpdate,
      localSha,
      remoteSha,
      behindBy,
      commits,
      checkedAt: new Date().toISOString()
    };

    checkCache = { result, timestamp: Date.now() };
    writeUpdateConfig({ lastCheckedAt: result.checkedAt });

    return result;
  } catch (error) {
    console.error("Update check failed:", error);
    throw error;
  }
}

export async function getLocalVersion() {
    try {
      const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H|%h|%s"], { cwd: process.cwd() });
      const [full, short, message] = stdout.trim().split('|');
      return { full, short, message };
    } catch {
      return { full: "unknown", short: "unknown", message: "" };
    }
}
