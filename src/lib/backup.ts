/**
 * Backup Engine
 * Pura lógica de backup, sem dependência de framework.
 * Suporta OpenClaw + Dashboard com retenção e manifesto.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { getOpenClawDir } from "./openclaw-config";

const execAsync = promisify(exec);

export interface BackupConfig {
  enabled: boolean;
  schedule: string; // cron-like or HH:MM
  /** Number of most recent backups to keep — anything older is discarded. */
  retentionCount: number;
  /** @deprecated legacy day-based retention. Kept on disk for migration only. */
  retentionDays?: number;
  destination: string;
  includeEnv: boolean;
  lastBackupAt?: string;
  nextBackupAt?: string;
}

export interface BackupOrigin {
  homeDir: string;
  platform: NodeJS.Platform;
  hostname: string;
  user: string;
  nodeVersion: string;
  openclawDir?: string;
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
  origin?: BackupOrigin;
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

/**
 * Default backup destination lives *outside* the project tree so that even
 * custom configurations cannot accidentally recurse (compacting backups into
 * backups). Falls back to `./data/backups` only when HOME is unavailable.
 */
function defaultDestination(): string {
  try {
    return path.join(os.homedir(), "AtlasDeckBackups");
  } catch {
    return "./data/backups";
  }
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  schedule: "04:00",
  retentionCount: 7,
  destination: defaultDestination(),
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
    const merged: BackupConfig = { ...DEFAULT_CONFIG, ...parsed };
    // Legacy configs only had `retentionDays` — fall back to the new default
    // (keep last 7 backups) so a fresh feature ships with no manual edit.
    if (typeof parsed.retentionCount !== "number") {
      merged.retentionCount = DEFAULT_CONFIG.retentionCount;
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Resolve the schedule string ("HH:MM") into the next absolute Date when it
 * will fire, relative to `fromDate`. Returns null if the string is malformed.
 */
export function computeNextRun(schedule: string, fromDate: Date = new Date()): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule || "");
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10));
  const min = Math.min(59, parseInt(m[2], 10));
  const next = new Date(fromDate);
  next.setHours(h, min, 0, 0);
  if (next.getTime() <= fromDate.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
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

  // Claude Code user-level data (~/.claude/)
  // The OpenClaw-created skills live here, not under ~/.codex, so they must be
  // captured for a full restore on another machine.
  try {
    const claudeDir = path.join(os.homedir(), ".claude");
    if (fs.existsSync(claudeDir)) {
      const claudeTargets = [
        { label: "claude-skills", rel: "skills" },
        { label: "claude-plugins", rel: "plugins" },
        { label: "claude-settings", rel: "settings.json" },
        { label: "claude-projects", rel: "projects" },
      ];
      for (const t of claudeTargets) {
        const full = path.join(claudeDir, t.rel);
        if (fs.existsSync(full)) {
          paths.push({ label: t.label, path: full });
        }
      }
    }
  } catch (err) {
    console.warn("[backup] Could not discover Claude Code paths:", err);
  }

  return paths;
}

function validateSafePath(target: string, base: string): boolean {
  const resolved = path.resolve(target);
  const resolvedBase = path.resolve(base);
  return resolved.startsWith(resolvedBase) && !resolved.includes("..") && resolved !== "/";
}

export interface RunBackupOptions {
  /**
   * Custom filename prefix for the archive. Defaults to "openclaw-backup".
   * Used by the restore flow to produce `pre-restore-<ts>.tar.gz` snapshots
   * that are easy to distinguish from regular backups.
   */
  archiveNamePrefix?: string;
}

export async function runBackup(opts: RunBackupOptions = {}): Promise<BackupResult> {
  const config = readBackupConfig();
  const dest = path.resolve(config.destination);
  const startedAt = new Date();
  const ts = timestampForFile(startedAt);
  const prefix = opts.archiveNamePrefix || "openclaw-backup";
  const archiveName = `${prefix}_${ts}.tar.gz`;
  const logName = `${prefix === "openclaw-backup" ? "backup" : prefix}-${ts}.log`;
  const archivePath = path.join(dest, archiveName);
  const logPath = path.join(dest, logName);

  fs.mkdirSync(dest, { recursive: true });

  const logLines: string[] = [];
  const log = (line: string) => {
    const lineWithTime = `[${new Date().toISOString()}] ${line}`;
    logLines.push(lineWithTime);
    console.log(lineWithTime);
  };

  let openclawDirForOrigin: string | undefined;
  try {
    openclawDirForOrigin = getOpenClawDir();
  } catch {
    openclawDirForOrigin = undefined;
  }

  const origin: BackupOrigin = {
    homeDir: os.homedir(),
    platform: process.platform,
    hostname: os.hostname(),
    user: os.userInfo().username,
    nodeVersion: process.version,
    openclawDir: openclawDirForOrigin,
  };

  log("============================================");
  log("OpenClaw + Dashboard Backup Started");
  log(`Timestamp: ${ts}`);
  log(`Destination: ${dest}`);
  log(`Retention policy: keep last ${config.retentionCount} backup(s)`);
  log(`Origin: ${origin.user}@${origin.hostname} (${origin.platform}) home=${origin.homeDir}`);
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

    // Drop an origin manifest inside ./data so the tarball is self-describing.
    // ./data is already part of the source set, so the file lands at the
    // predictable path data/backup-origin.json after restore.
    const dataDir = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const originFile = path.join(dataDir, "backup-origin.json");
    fs.writeFileSync(
      originFile,
      JSON.stringify(
        {
          ...origin,
          timestamp: startedAt.toISOString(),
          includedPaths: sources,
        },
        null,
        2
      ),
      "utf-8"
    );

    // Build tar command
    // Use a temp file list to handle spaces and special chars safely
    const listFile = path.join(dest, `.backup-list-${ts}.txt`);
    const listContent = sources.map((s) => s.path).join("\n");
    fs.writeFileSync(listFile, listContent, "utf-8");

    log(`Creating archive: ${archiveName}`);
    // Dynamic exclusion: always exclude the backup destination itself (whatever
    // it is configured to), to prevent recursive "backup of backups" growth.
    // tar excludes match anywhere in the path so we feed multiple variants.
    const destAbs = path.resolve(dest);
    const destRelFromCwd = path.relative(process.cwd(), destAbs);
    const destExcludes = new Set<string>();
    destExcludes.add(destAbs);
    if (destRelFromCwd && !destRelFromCwd.startsWith("..")) {
      destExcludes.add(destRelFromCwd);
      destExcludes.add(`./${destRelFromCwd}`);
    }
    destExcludes.add(path.basename(destAbs));
    const destExcludeFlags = [...destExcludes].map((d) => `--exclude="${d}"`).join(" ");

    const tarCmd =
      `tar --exclude="node_modules" --exclude=".next" --exclude=".git" ` +
      `--exclude="*.tar.gz" --exclude="*.log" ${destExcludeFlags} ` +
      `-czf "${archivePath}" -T "${listFile}"`;
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

  // Update manifest first so retention can act on a single source of truth.
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
    origin,
  };

  manifest.entries.unshift(entry);
  manifest.config = config;
  manifest.totalSizeBytes = manifest.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  writeManifest(dest, manifest);

  // Apply retention against the updated manifest (count-based).
  try {
    applyRetention(dest, config.retentionCount, log);
  } catch (err) {
    log(`Retention cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }

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
  retentionCount: number,
  log: (line: string) => void
) {
  if (retentionCount <= 0) return;

  const manifest = readManifest(dest);
  if (manifest.entries.length <= retentionCount) return;

  // Sort by startedAt desc; keep the most recent N, evict the rest from disk.
  const sorted = [...manifest.entries].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  const toKeep = sorted.slice(0, retentionCount);
  const toRemove = sorted.slice(retentionCount);

  const keepFiles = new Set<string>();
  for (const e of toKeep) {
    keepFiles.add(e.filename);
    if (e.logFile) keepFiles.add(e.logFile);
  }

  let removed = 0;
  for (const entry of toRemove) {
    const archivePath = path.join(dest, entry.filename);
    const logPath = entry.logFile ? path.join(dest, entry.logFile) : null;
    try {
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    } catch {}
    try {
      if (logPath && fs.existsSync(logPath)) fs.unlinkSync(logPath);
    } catch {}
    removed++;
    log(`Retention: removed old backup ${entry.filename}`);
  }

  // Also sweep any orphan archive/log files not present in the kept set
  // (e.g. leftovers from manual deletions outside the manifest).
  try {
    const onDisk = fs.readdirSync(dest);
    for (const file of onDisk) {
      if (file === "manifest.json") continue;
      if (file.startsWith(".backup-list-")) continue;
      if (!file.endsWith(".tar.gz") && !file.endsWith(".log")) continue;
      if (keepFiles.has(file)) continue;
      const full = path.join(dest, file);
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  } catch {}

  manifest.entries = toKeep;
  manifest.totalSizeBytes = toKeep.reduce((sum, e) => sum + e.sizeBytes, 0);
  writeManifest(dest, manifest);

  if (removed > 0) {
    log(`Retention policy applied: kept ${toKeep.length}, removed ${removed} older`);
  }
}

export interface RestorePreview {
  origin: BackupOrigin | null;
  currentHome: string;
  currentPlatform: NodeJS.Platform;
  needsRemap: boolean;
  platformMismatch: boolean;
  mappings: Array<{ from: string; to: string; exists: boolean }>;
  archivePath: string;
  entries: number; // total entries in tar
  uncompressedBytes: number; // approximate (sum of sizes)
}

export interface RestoreResult {
  success: boolean;
  preview: RestorePreview;
  restored: Array<{ source: string; target: string; bytes: number }>;
  skipped: Array<{ source: string; reason: string }>;
  staging: string;
  durationMs: number;
  error?: string;
}

interface RestoreOptions {
  dryRun?: boolean;
  /** When true, overwrite existing files at the target. Default true. */
  overwrite?: boolean;
  /** When true, keep the staging directory after restore. */
  keepStaging?: boolean;
  /** Override target home directory (defaults to os.homedir()). */
  targetHomeDir?: string;
}

/**
 * Inspect a backup archive without extracting it.
 * Reads `data/backup-origin.json` from inside the tar and computes the
 * path mappings that would be applied if restored on this machine.
 */
export async function previewRestore(archivePath: string): Promise<RestorePreview> {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  // Read origin file directly from tar (no extract)
  let origin: BackupOrigin | null = null;
  let entries = 0;
  try {
    const listing = execSync(`tar -tzf "${archivePath}"`, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 64 });
    const lines = listing.split("\n").filter(Boolean);
    entries = lines.length;
    const originEntry = lines.find((l) => l.endsWith("data/backup-origin.json"));
    if (originEntry) {
      const { stdout } = await execAsync(`tar -xzOf "${archivePath}" "${originEntry}"`, {
        maxBuffer: 1024 * 1024 * 8,
        encoding: "utf-8",
      });
      const parsed = JSON.parse(stdout) as BackupOrigin & { includedPaths?: Array<{ label: string; path: string }> };
      origin = {
        homeDir: parsed.homeDir,
        platform: parsed.platform,
        hostname: parsed.hostname,
        user: parsed.user,
        nodeVersion: parsed.nodeVersion,
        openclawDir: parsed.openclawDir,
      };
    }
  } catch (err) {
    throw new Error(`Failed to read archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const currentHome = os.homedir();
  const currentPlatform = process.platform;
  const platformMismatch = !!origin && origin.platform !== currentPlatform;
  const needsRemap = !!origin && origin.homeDir !== currentHome;

  // Compute candidate mappings: only when origin homeDir is known
  const mappings: Array<{ from: string; to: string; exists: boolean }> = [];
  if (origin) {
    const fromBase = origin.homeDir;
    const toBase = currentHome;
    mappings.push({ from: fromBase, to: toBase, exists: fs.existsSync(toBase) });
  }

  return {
    origin,
    currentHome,
    currentPlatform,
    needsRemap,
    platformMismatch,
    mappings,
    archivePath,
    entries,
    uncompressedBytes: 0, // tar -tzf doesn't give sizes cheaply; left at 0 unless needed
  };
}

/**
 * Restore a backup archive to the current machine.
 *
 * Strategy: extract everything to a staging directory, then move/copy files
 * from `<staging>/<oldHome-without-leading-slash>/...` into `<currentHome>/...`.
 * The dashboard's project tree (cwd) is also restored if present in the tar.
 *
 * Notes:
 *   - Platform mismatches (e.g. linux→darwin) are blocked unless caller passes
 *     overwrite=true AND understands the risk (no automatic remap for
 *     Windows-style paths today — only POSIX homes).
 *   - With dryRun=true, no files are moved; a plan is returned in `restored`.
 */
export async function restoreBackup(
  archivePath: string,
  opts: RestoreOptions = {}
): Promise<RestoreResult> {
  const start = Date.now();
  const overwrite = opts.overwrite !== false;
  const dryRun = !!opts.dryRun;
  const keepStaging = !!opts.keepStaging;
  const targetHome = opts.targetHomeDir || os.homedir();

  const preview = await previewRestore(archivePath);

  if (preview.platformMismatch) {
    throw new Error(
      `Platform mismatch: backup from ${preview.origin?.platform}, restoring on ${preview.currentPlatform}. ` +
        `Cross-platform restore is not supported (path separators and home layouts differ).`
    );
  }
  if (!preview.origin) {
    throw new Error(
      "Backup is missing data/backup-origin.json — cannot determine original home directory. " +
        "This archive was likely created before the origin-metadata feature was added."
    );
  }

  // Staging directory under data/.restore-staging/<ts>
  const ts = timestampForFile();
  const staging = path.join(process.cwd(), "data", ".restore-staging", ts);
  fs.mkdirSync(staging, { recursive: true });

  // Extract everything into staging
  try {
    await execAsync(`tar -xzf "${archivePath}" -C "${staging}"`, {
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 64,
      encoding: "utf-8",
    });
  } catch (err) {
    throw new Error(
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}. Staging: ${staging}`
    );
  }

  const oldHome = preview.origin.homeDir;
  // tar strips leading '/', so paths inside staging look like:
  //   <staging>/Users/oldUser/.claude/...           (was /Users/oldUser/.claude/...)
  //   <staging>/Users/oldUser/Dev/AtlasDeck/data    (project dir, also under old home if old project was inside old home)
  // We rebuild absolute targets by replacing the old-home prefix with targetHome.

  const oldHomeKey = oldHome.replace(/^\/+/, "").replace(/\/+$/, ""); // 'Users/felipeandrade'
  const restored: Array<{ source: string; target: string; bytes: number }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];

  // Discover top-level "anchor" directories inside the staging dir.
  // We walk recursively under the old-home prefix and move everything.
  const oldHomeStaging = path.join(staging, oldHomeKey);
  if (!fs.existsSync(oldHomeStaging)) {
    // No old-home prefix in archive — nothing to remap to home. The archive
    // may still contain absolute paths outside the home (e.g. /etc/...), but
    // we deliberately do NOT touch those for safety.
    skipped.push({
      source: staging,
      reason: `No '${oldHomeKey}' prefix found inside archive; nothing to restore to current home.`,
    });
  } else {
    await walkAndPlan(oldHomeStaging, targetHome, restored, skipped, overwrite, dryRun);
  }

  // Cleanup staging unless asked to keep
  if (!keepStaging) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
  }

  return {
    success: true,
    preview,
    restored,
    skipped,
    staging,
    durationMs: Date.now() - start,
  };
}

/**
 * Recursively walk a staged home-prefix directory and copy each file to the
 * corresponding location under `targetHome`. Exported for the restore worker
 * script (`scripts/restore-apply.ts`) which runs the apply-home phase while
 * the Next.js process is stopped.
 */
export async function walkAndPlan(
  stagingHomeRoot: string,
  targetHome: string,
  restored: Array<{ source: string; target: string; bytes: number }>,
  skipped: Array<{ source: string; reason: string }>,
  overwrite: boolean,
  dryRun: boolean
) {
  const stack: string[] = [stagingHomeRoot];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const source = path.join(current, entry.name);
      const relFromHome = path.relative(stagingHomeRoot, source);
      const target = path.join(targetHome, relFromHome);
      if (entry.isDirectory()) {
        if (!dryRun) fs.mkdirSync(target, { recursive: true });
        stack.push(source);
        continue;
      }
      if (entry.isFile()) {
        const exists = fs.existsSync(target);
        if (exists && !overwrite) {
          skipped.push({ source, reason: "target exists; overwrite=false" });
          continue;
        }
        let bytes = 0;
        try {
          bytes = fs.statSync(source).size;
        } catch {}
        if (!dryRun) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        }
        restored.push({ source, target, bytes });
      }
    }
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
  const nextRun = config.enabled ? computeNextRun(config.schedule) : null;

  return {
    config,
    lastSuccess,
    totalBackups,
    totalSizeBytes: totalSize,
    totalSizeHuman: formatBytes(totalSize),
    nextBackupAt: nextRun ? nextRun.toISOString() : null,
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
  // Log to a path the cron-running user can write to — /var/log needs root on
  // macOS and many Linux distros, which would silently break the install.
  const logFile = path.join(projectDir, "data", "backup-cron.log");
  // Cron runs with a very minimal PATH; resolve `npx` to an absolute path so
  // the line works on fresh installs without the user editing PATH= entries.
  let npxBin = "npx";
  try {
    const resolved = execSync("command -v npx", { encoding: "utf-8" }).trim();
    if (resolved) npxBin = resolved;
  } catch {
    // fall back to bare `npx` — user can edit crontab manually if PATH is bare
  }
  const command = `cd ${projectDir} && ${npxBin} tsx scripts/backup.ts >> "${logFile}" 2>&1`;
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

/**
 * Idempotently install the backup cron if config.enabled=true and no cron line
 * is currently registered. Meant to be called at server startup so a fresh
 * install gets the 04:00 nightly backup without the user having to open the UI.
 *
 * Returns { changed: true } when the crontab was actually modified.
 */
export function ensureBackupCronInstalled(projectDir: string = process.cwd()):
  | { changed: false; reason: string }
  | { changed: true; message: string } {
  if (process.platform === "win32") {
    return { changed: false, reason: "platform=win32 (cron not supported)" };
  }

  const config = readBackupConfig();
  if (!config.enabled) {
    return { changed: false, reason: "config.enabled=false" };
  }

  const status = getSystemCronStatus();
  if (status.scheduled) {
    return { changed: false, reason: "cron already installed" };
  }

  // Parse schedule like "HH:MM" — fall back to 04:00 on parse failure.
  const m = /^(\d{1,2}):(\d{2})$/.exec(config.schedule || "");
  const hours = m ? Math.min(23, parseInt(m[1], 10)) : 4;
  const minutes = m ? Math.min(59, parseInt(m[2], 10)) : 0;

  try {
    const res = scheduleSystemCron(projectDir, minutes, hours, true);
    if (res.success) {
      return { changed: true, message: res.message };
    }
    return { changed: false, reason: `scheduleSystemCron failed: ${res.message}` };
  } catch (err) {
    return {
      changed: false,
      reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
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

/**
 * Lock file that gates concurrent backup/restore. `scripts/backup.ts` and
 * `runBackup()` should consult this before touching disk; `scripts/restore.sh`
 * grabs it before extracting so a 04:00 cron backup cannot collide with an
 * in-flight restore.
 */
function restoreLockPath(): string {
  return path.join(process.cwd(), "data", ".restore.lock");
}

export function isRestoreLockHeld(): { locked: boolean; pid?: number; reason?: string } {
  try {
    const raw = fs.readFileSync(restoreLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as { pid?: number; reason?: string };
    if (parsed.pid && parsed.pid > 0) {
      try {
        process.kill(parsed.pid, 0);
        return { locked: true, pid: parsed.pid, reason: parsed.reason };
      } catch {
        // Holder process is dead — lock is stale, treat as unlocked.
        return { locked: false };
      }
    }
    return { locked: true, reason: parsed.reason };
  } catch {
    return { locked: false };
  }
}

export function acquireRestoreLock(reason: string, pid: number = process.pid): boolean {
  const state = isRestoreLockHeld();
  if (state.locked) return false;
  const lockPath = restoreLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid, reason, acquiredAt: new Date().toISOString() }, null, 2));
  return true;
}

export function releaseRestoreLock(): void {
  try {
    fs.unlinkSync(restoreLockPath());
  } catch {}
}
