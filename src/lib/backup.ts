/**
 * Backup Engine
 * Pura lógica de backup, sem dependência de framework.
 * Suporta OpenClaw + Dashboard com retenção e manifesto.
 */

import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { getOpenClawDir } from "./openclaw-config";

const execAsync = promisify(exec);

export interface BackupConfig {
  enabled: boolean;
  schedule: string; // cron-like or HH:MM
  retentionDays: number;
  destination: string;
  includeEnv: boolean;
  lastBackupAt?: string;
  nextBackupAt?: string;
}

export interface BackupEntry {
  id: string; // timestamp ISO
  filename: string;
  logFile: string;
  sizeBytes: number;
  sizeHuman: string;
  status: "success" | "error" | "running";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  includedPaths: string[];
}

export interface BackupManifest {
  config: BackupConfig;
  entries: BackupEntry[];
  totalSizeBytes: number;
}

export interface BackupResult {
  success: boolean;
  entry: BackupEntry;
  logPath: string;
  archivePath: string;
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  schedule: "04:00",
  retentionDays: 5,
  destination: "./data/backups",
  includeEnv: true,
};

function configPath(): string {
  return path.join(process.cwd(), "data", "backup-config.json");
}

function manifestPath(dest: string): string {
  return path.join(dest, "manifest.json");
}

export function readBackupConfig(): BackupConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BackupConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeBackupConfig(config: BackupConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function readManifest(dest: string): BackupManifest {
  try {
    const raw = fs.readFileSync(manifestPath(dest), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BackupManifest>;
    return {
      config: parsed.config || readBackupConfig(),
      entries: parsed.entries || [],
      totalSizeBytes: parsed.totalSizeBytes || 0,
    };
  } catch {
    return {
      config: readBackupConfig(),
      entries: [],
      totalSizeBytes: 0,
    };
  }
}

function writeManifest(dest: string, manifest: BackupManifest): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(manifestPath(dest), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function timestampForFile(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function discoverPaths(): { label: string; path: string }[] {
  const paths: { label: string; path: string }[] = [];

  // Dashboard data
  const cwd = process.cwd();
  const dataDir = path.join(cwd, "data");
  if (fs.existsSync(dataDir)) {
    paths.push({ label: "dashboard-data", path: dataDir });
  }

  // .env
  const envPath = path.join(cwd, ".env");
  if (fs.existsSync(envPath)) {
    paths.push({ label: "env", path: envPath });
  }

  // OpenClaw
  try {
    const openclawDir = getOpenClawDir();
    if (fs.existsSync(openclawDir)) {
      // Master config
      const configFile = path.join(openclawDir, "openclaw.json");
      if (fs.existsSync(configFile)) {
        paths.push({ label: "openclaw-config", path: configFile });
      }

      // Agents sessions
      const agentsDir = path.join(openclawDir, "agents");
      if (fs.existsSync(agentsDir)) {
        paths.push({ label: "openclaw-agents", path: agentsDir });
      }

      // Media
      const mediaDir = path.join(openclawDir, "media");
      if (fs.existsSync(mediaDir)) {
        paths.push({ label: "openclaw-media", path: mediaDir });
      }

      // Workspaces
      const workspaceDir = path.join(openclawDir, "workspace");
      if (fs.existsSync(workspaceDir)) {
        paths.push({ label: "openclaw-workspace", path: workspaceDir });
      }

      // Additional workspaces (studio, infra, etc.)
      const entries = fs.readdirSync(openclawDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          entry.name.startsWith("workspace-") &&
          entry.name !== "workspace"
        ) {
          const wsPath = path.join(openclawDir, entry.name);
          paths.push({ label: `openclaw-${entry.name}`, path: wsPath });
        }
      }

      // Skills
      const skillsDir = path.join(openclawDir, "skills");
      if (fs.existsSync(skillsDir)) {
        paths.push({ label: "openclaw-skills", path: skillsDir });
      }

      // Plugins
      const pluginsDir = path.join(openclawDir, ".tmp", "plugins");
      if (fs.existsSync(pluginsDir)) {
        paths.push({ label: "openclaw-plugins", path: pluginsDir });
      }
    }
  } catch (err) {
    console.warn("[backup] Could not discover OpenClaw paths:", err);
  }

  return paths;
}

function validateSafePath(target: string, base: string): boolean {
  const resolved = path.resolve(target);
  const resolvedBase = path.resolve(base);
  return resolved.startsWith(resolvedBase) && !resolved.includes("..") && resolved !== "/";
}

export async function runBackup(): Promise<BackupResult> {
  const config = readBackupConfig();
  const dest = path.resolve(config.destination);
  const startedAt = new Date();
  const ts = timestampForFile(startedAt);
  const archiveName = `openclaw-backup_${ts}.tar.gz`;
  const logName = `backup-${ts}.log`;
  const archivePath = path.join(dest, archiveName);
  const logPath = path.join(dest, logName);

  fs.mkdirSync(dest, { recursive: true });

  const logLines: string[] = [];
  const log = (line: string) => {
    const lineWithTime = `[${new Date().toISOString()}] ${line}`;
    logLines.push(lineWithTime);
    console.log(lineWithTime);
  };

  log("============================================");
  log("OpenClaw + Dashboard Backup Started");
  log(`Timestamp: ${ts}`);
  log(`Destination: ${dest}`);
  log(`Retention policy: ${config.retentionDays} days`);
  log("============================================");

  const includedPaths: string[] = [];
  let success = false;
  let errorMsg: string | undefined;

  try {
    const sources = discoverPaths();
    log(`Discovered ${sources.length} source paths:`);
    for (const s of sources) {
      log(`  - ${s.label}: ${s.path}`);
      includedPaths.push(s.path);
    }

    // Build tar command
    // Use a temp file list to handle spaces and special chars safely
    const listFile = path.join(dest, `.backup-list-${ts}.txt`);
    const listContent = sources.map((s) => s.path).join("\n");
    fs.writeFileSync(listFile, listContent, "utf-8");

    log(`Creating archive: ${archiveName}`);
    const tarCmd = `tar --exclude="node_modules" --exclude=".next" --exclude="data/backups" --exclude=".git" --exclude="*.tar.gz" --exclude="*.log" -czf "${archivePath}" -T "${listFile}"`;
    await execAsync(tarCmd, { timeout: 300000, encoding: "utf-8" });

    fs.unlinkSync(listFile);

    const stats = fs.statSync(archivePath);
    log(`Archive created: ${archiveName} (${formatBytes(stats.size)})`);

    // Restrict permissions
    try {
      fs.chmodSync(archivePath, 0o600);
    } catch {
      // ignore on Windows
    }

    success = true;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${errorMsg}`);
    // Clean up partial archive
    try {
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    } catch {
      // ignore
    }
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  log("============================================");
  log(`Result: ${success ? "SUCCESS" : "FAILED"}`);
  if (success) {
    log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  } else {
    log(`Error: ${errorMsg}`);
  }
  log("============================================");

  // Write log file
  fs.writeFileSync(logPath, logLines.join("\n") + "\n", "utf-8");

  // Apply retention
  try {
    applyRetention(dest, config.retentionDays, log);
  } catch (err) {
    log(`Retention cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Update manifest
  const manifest = readManifest(dest);
  const archiveStats = fs.existsSync(archivePath) ? fs.statSync(archivePath) : { size: 0 };

  const entry: BackupEntry = {
    id: startedAt.toISOString(),
    filename: archiveName,
    logFile: logName,
    sizeBytes: archiveStats.size,
    sizeHuman: formatBytes(archiveStats.size),
    status: success ? "success" : "error",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    error: errorMsg,
    includedPaths,
  };

  manifest.entries.unshift(entry);
  manifest.config = config;
  manifest.totalSizeBytes = manifest.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  writeManifest(dest, manifest);

  // Update config lastBackupAt
  config.lastBackupAt = startedAt.toISOString();
  writeBackupConfig(config);

  return {
    success,
    entry,
    logPath,
    archivePath: success ? archivePath : "",
  };
}

function applyRetention(
  dest: string,
  retentionDays: number,
  log: (line: string) => void
) {
  if (retentionDays <= 0) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dest);
  let removed = 0;

  for (const file of files) {
    if (file === "manifest.json") continue;
    const fullPath = path.join(dest, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtime.getTime() < cutoff) {
      fs.unlinkSync(fullPath);
      removed++;
      log(`Retention: removed old file ${file}`);
    }
  }

  if (removed > 0) {
    log(`Retention policy applied: ${removed} file(s) removed (> ${retentionDays} days)`);
  }
}

export function deleteBackup(entryId: string, dest?: string): boolean {
  const config = readBackupConfig();
  const destination = dest ? path.resolve(dest) : path.resolve(config.destination);
  const manifest = readManifest(destination);

  const idx = manifest.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return false;

  const entry = manifest.entries[idx];

  // Remove files
  const archivePath = path.join(destination, entry.filename);
  const logPath = path.join(destination, entry.logFile);
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  // Update manifest
  manifest.entries.splice(idx, 1);
  manifest.totalSizeBytes = manifest.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  writeManifest(destination, manifest);

  return true;
}

export function getBackupStats(dest?: string) {
  const config = readBackupConfig();
  const destination = dest ? path.resolve(dest) : path.resolve(config.destination);
  const manifest = readManifest(destination);

  const lastSuccess = manifest.entries.find((e) => e.status === "success");
  const totalBackups = manifest.entries.length;
  const totalSize = manifest.totalSizeBytes;

  return {
    config,
    lastSuccess,
    totalBackups,
    totalSizeBytes: totalSize,
    totalSizeHuman: formatBytes(totalSize),
    entries: manifest.entries,
  };
}

/**
 * Schedule backup in system crontab (Linux/macOS).
 * Returns true if schedule was changed.
 */
export function scheduleSystemCron(
  projectDir: string,
  scheduleMinutes: number,
  scheduleHours: number,
  enable: boolean
): { success: boolean; message: string } {
  const marker = "# mission-control-backup";
  const command = `cd ${projectDir} && npx tsx scripts/backup.ts >> /var/log/mission-control-backup.log 2>&1`;
  const cronLine = `${scheduleMinutes} ${scheduleHours} * * * ${command} ${marker}`;

  try {
    let current = "";
    try {
      current = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
    } catch {
      // no crontab yet
    }

    const lines = current.split("\n").filter((l) => !l.includes(marker));

    if (enable) {
      lines.push(cronLine);
    }

    const newCrontab = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    execSync("crontab -", {
      input: newCrontab,
      encoding: "utf-8",
    });

    return {
      success: true,
      message: enable
        ? `Backup scheduled daily at ${String(scheduleHours).padStart(2, "0")}:${String(
            scheduleMinutes
          ).padStart(2, "0")}`
        : "Backup schedule removed",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

export function getSystemCronStatus(): { scheduled: boolean; line?: string } {
  const marker = "# mission-control-backup";
  try {
    const current = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
    const line = current.split("\n").find((l) => l.includes(marker));
    return { scheduled: !!line, line };
  } catch {
    return { scheduled: false };
  }
}
