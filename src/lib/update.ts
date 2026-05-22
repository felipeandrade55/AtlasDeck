import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface UpdateConfig {
  autoCheck: boolean;
  checkIntervalMinutes: number;
  repoOwner: string;
  repoName: string;
  branch: string;
  backupBeforeUpdate: boolean;
  lastCheckedAt: string | null;
  lastNotifiedSha: string | null;
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

export type UpdatePhaseName =
  | "backup"
  | "credentials"
  | "git-pull"
  | "npm-install"
  | "setup-memory"
  | "ollama-install"
  | "build"
  | "pm2-restart"
  | "health-check"
  | "openclaw-gateway"
  | "fail2ban"
  | "firewall";

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
  logs?: string;
}

export interface UpdateLiveStatus {
  sessionId: string;
  historyId: string;
  pid: number;
  status: "running" | "complete" | "error";
  startedAt: string;
  completedAt?: string;
  lastHeartbeat: string;
  currentPhase: string;
  phases: UpdatePhase[];
  fromSha: string;
  toSha: string;
  logFile: string;
  statusFile: string;
  error?: string;
}

const DEFAULT_CONFIG: UpdateConfig = {
  autoCheck: true,
  checkIntervalMinutes: 5,
  repoOwner: "felipeandrade55",
  repoName: "AtlasDeck",
  branch: "main",
  backupBeforeUpdate: true,
  lastCheckedAt: null,
  lastNotifiedSha: null,
};

const PHASE_ORDER: UpdatePhaseName[] = [
  "backup",
  "credentials",
  "git-pull",
  "npm-install",
  "setup-memory",
  "ollama-install",
  "build",
  "pm2-restart",
  "health-check",
  "openclaw-gateway",
  "fail2ban",
  "firewall",
];

function configPath(): string {
  return path.join(process.cwd(), "data", "update-config.json");
}

function historyPath(): string {
  return path.join(process.cwd(), "data", "update-history.json");
}

export function liveStatusPath(): string {
  return path.join(process.cwd(), "data", "update-live-status.json");
}

export function liveLogPath(): string {
  return path.join(process.cwd(), "data", "update-current.log");
}

export function phaseEventsPath(): string {
  return path.join(process.cwd(), "data", "update-phase-events.log");
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
  const index = history.updates.findIndex((e) => e.id === id);
  if (index !== -1) {
    history.updates[index] = { ...history.updates[index], ...partial };
    fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2), "utf-8");
  }
}

export function readLiveStatus(): UpdateLiveStatus | null {
  try {
    const raw = fs.readFileSync(liveStatusPath(), "utf-8");
    return JSON.parse(raw) as UpdateLiveStatus;
  } catch {
    return null;
  }
}

export function writeLiveStatus(status: UpdateLiveStatus) {
  fs.mkdirSync(path.dirname(liveStatusPath()), { recursive: true });
  fs.writeFileSync(liveStatusPath(), JSON.stringify(status, null, 2), "utf-8");
}

export function clearLiveStatus() {
  try {
    fs.unlinkSync(liveStatusPath());
  } catch {}
}

/**
 * Returns mtime (ms since epoch) of the most recently modified update artifact.
 * Used as a reliable proof-of-life signal: bash writes heartbeat/log lines via
 * `>>` (bypasses stdio buffering), so the file mtime reflects subprocess
 * activity even if the Next.js process was too CPU-starved to run the
 * reconciler. Returns 0 if nothing is found.
 */
function freshestArtifactMs(): number {
  let latest = 0;
  for (const p of [phaseEventsPath(), liveLogPath()]) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {}
  }
  return latest;
}

/**
 * Returns the active update if there's one running with a fresh heartbeat.
 *
 * The "heartbeat" is the max of the persisted lastHeartbeat (refreshed by
 * the reconciler when it picks up new phase/log events) and the artifact
 * file mtimes (refreshed whenever bash appends — never delayed by the
 * Node.js event loop). If both are stale beyond DEAD_THRESHOLD_MS *and*
 * the PID is dead, the update is reconciled into an error state.
 */
const DEAD_THRESHOLD_MS = 300_000; // 5 min — generous to absorb CPU spikes during `next build`

export function getActiveUpdate(): UpdateLiveStatus | null {
  const status = readLiveStatus();
  if (!status) return null;

  if (status.status !== "running") return status;

  const persistedHb = new Date(status.lastHeartbeat).getTime();
  const artifactHb = freshestArtifactMs();
  const effectiveHb = Math.max(persistedHb, artifactHb);

  // Reflect the freshest signal back to the UI so the "no heartbeat for Xs"
  // counter doesn't lag behind the actual subprocess activity.
  if (artifactHb > persistedHb) {
    status.lastHeartbeat = new Date(artifactHb).toISOString();
  }

  const now = Date.now();
  const ageMs = now - effectiveHb;

  if (ageMs > DEAD_THRESHOLD_MS) {
    // Check if PID is alive
    let alive = false;
    if (status.pid > 0) {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }

    if (!alive) {
      const reconciled: UpdateLiveStatus = {
        ...status,
        status: "error",
        error: `Processo de update encerrou inesperadamente (sem heartbeat há mais de ${Math.round(DEAD_THRESHOLD_MS / 1000)}s).`,
        completedAt: new Date().toISOString(),
      };
      writeLiveStatus(reconciled);
      try {
        updateHistoryEntry(status.historyId, {
          status: "error",
          error: reconciled.error,
          completedAt: reconciled.completedAt,
        });
      } catch {}
      // Notifica o sino sobre a falha (import dinâmico para evitar ciclo)
      void import("./update-notifier")
        .then(({ notifyUpdateResult }) =>
          notifyUpdateResult(false, status.fromSha, status.toSha, undefined, reconciled.error)
        )
        .catch(() => {});
      return reconciled;
    }
  }

  return status;
}

export function isUpdateRunning(): boolean {
  const live = getActiveUpdate();
  return live?.status === "running";
}

let checkCache: { result: UpdateCheckResult; timestamp: number } | null = null;

export function invalidateCheckCache() {
  checkCache = null;
}

export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  if (!force && checkCache && Date.now() - checkCache.timestamp < 60000) {
    return checkCache.result;
  }

  const config = readUpdateConfig();
  const headers: Record<string, string> = {
    "User-Agent": "AtlasDeck-Update",
    Accept: "application/vnd.github.v3+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    let localSha = "";
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
      });
      localSha = stdout.trim();
    } catch (e) {
      console.warn("Could not get local git SHA. Is git installed and is this a git repo?", e);
    }

    if (!localSha) {
      throw new Error("Could not determine local git version.");
    }

    const branchRes = await fetch(
      `https://api.github.com/repos/${config.repoOwner}/${config.repoName}/commits/${config.branch}`,
      { headers }
    );
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
      const compareRes = await fetch(
        `https://api.github.com/repos/${config.repoOwner}/${config.repoName}/compare/${localSha}...${remoteSha}`,
        { headers }
      );
      if (compareRes.ok) {
        const compareData = await compareRes.json();
        if (
          compareData.status === "ahead" ||
          compareData.status === "diverged" ||
          compareData.behind_by > 0
        ) {
          hasUpdate = compareData.behind_by > 0 || compareData.commits.length > 0;
          behindBy = compareData.behind_by || compareData.commits.length;

          for (const commit of compareData.commits.reverse()) {
            commits.push({
              sha: commit.sha,
              message: commit.commit.message.split("\n")[0],
              author: commit.commit.author.name,
              date: commit.commit.author.date,
            });
          }
        }
      } else {
        hasUpdate = true;
        commits.push({
          sha: remoteSha,
          message: branchData.commit.message.split("\n")[0],
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
      checkedAt: new Date().toISOString(),
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
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H|%h|%s"], {
      cwd: process.cwd(),
    });
    const [full, short, message] = stdout.trim().split("|");
    return { full, short, message };
  } catch {
    return { full: "unknown", short: "unknown", message: "" };
  }
}

export function buildInitialPhases(includeBackup: boolean): UpdatePhase[] {
  return PHASE_ORDER.filter((p) => includeBackup || p !== "backup").map((name) => ({
    name,
    status: "pending" as const,
  }));
}

export const PHASE_LABELS: Record<string, string> = {
  backup: "Backup",
  credentials: "Credenciais",
  "git-pull": "Git Pull",
  "npm-install": "Dependências",
  "setup-memory": "Setup Memória",
  "ollama-install": "Ollama",
  build: "Build",
  "pm2-restart": "Restart PM2",
  "health-check": "Health Check",
  "openclaw-gateway": "OpenClaw Gateway",
  fail2ban: "Fail2Ban",
  firewall: "Firewall",
};
