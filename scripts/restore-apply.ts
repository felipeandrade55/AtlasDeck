#!/usr/bin/env tsx
/**
 * Restore Apply — Standalone helper invoked by scripts/restore.sh.
 *
 * Runs the "apply" phases (data / env / home) AFTER the Next.js process has
 * been stopped, so the SQLite databases under data/ can be replaced safely.
 *
 * Usage:
 *   tsx scripts/restore-apply.ts data    --staging <dir>
 *   tsx scripts/restore-apply.ts env     --staging <dir>
 *   tsx scripts/restore-apply.ts home    --staging <dir> --old-home <key>
 *
 * Always writes a JSON line to stdout summarising the result so the parent
 * bash script can capture stats (files restored, bytes, errors).
 */

import fs from "fs";
import os from "os";
import path from "path";

import { walkAndPlan } from "../src/lib/backup";

type Mode = "data" | "env" | "home";

function parseArgs() {
  const argv = process.argv.slice(2);
  const mode = argv[0] as Mode | undefined;
  const out: { mode: Mode | undefined; staging: string; oldHome?: string } = {
    mode,
    staging: "",
    oldHome: undefined,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--staging") out.staging = argv[++i];
    else if (arg === "--old-home") out.oldHome = argv[++i];
  }
  return out;
}

function emit(result: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(result) + "\n");
}

function copyDirRecursive(source: string, target: string, skipNames: Set<string>): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack: Array<{ src: string; dst: string }> = [{ src: source, dst: target }];
  while (stack.length) {
    const { src, dst } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        stack.push({ src: srcPath, dst: dstPath });
      } else if (entry.isFile()) {
        try {
          fs.mkdirSync(path.dirname(dstPath), { recursive: true });
          fs.copyFileSync(srcPath, dstPath);
          const stat = fs.statSync(srcPath);
          bytes += stat.size;
          files += 1;
        } catch (err) {
          process.stderr.write(`[restore-apply] failed to copy ${srcPath}: ${(err as Error).message}\n`);
        }
      } else if (entry.isSymbolicLink()) {
        try {
          const linkTarget = fs.readlinkSync(srcPath);
          try { fs.unlinkSync(dstPath); } catch {}
          fs.symlinkSync(linkTarget, dstPath);
          files += 1;
        } catch (err) {
          process.stderr.write(`[restore-apply] failed to recreate symlink ${srcPath}: ${(err as Error).message}\n`);
        }
      }
    }
  }
  return { files, bytes };
}

async function applyData(staging: string) {
  // The staging tree mirrors the original cwd layout. The data/ folder lives
  // either directly inside the staging root (if backup was taken from cwd) or
  // somewhere under the old-home prefix. Search the most likely places:
  const candidates: string[] = [];
  candidates.push(path.join(staging, "data"));
  // Look for any nested .../Dev/AtlasDeck/data layout from the old home key.
  function discover(root: string, depth: number) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(root, entry.name);
      if (entry.name === "data" && fs.existsSync(path.join(sub, "backup-origin.json"))) {
        candidates.push(sub);
        continue;
      }
      discover(sub, depth + 1);
    }
  }
  discover(staging, 0);

  const dataSource = candidates.find((c) => fs.existsSync(path.join(c, "backup-origin.json")))
    || candidates.find((c) => fs.existsSync(c));

  if (!dataSource) {
    emit({ ok: false, error: "Could not locate data/ inside staging (no backup-origin.json marker found)" });
    process.exit(1);
  }

  const dataTarget = path.join(process.cwd(), "data");
  fs.mkdirSync(dataTarget, { recursive: true });

  // Clean WAL/SHM in the target before copy — app is stopped, this is safe.
  try {
    for (const file of fs.readdirSync(dataTarget)) {
      if (file.endsWith(".db-wal") || file.endsWith(".db-shm")) {
        try { fs.unlinkSync(path.join(dataTarget, file)); } catch {}
      }
    }
  } catch {}

  // Preserve restore-control files that must NOT be overwritten by the backup.
  const skip = new Set([
    "restore-live-status.json",
    "restore-current.log",
    "restore-phase-events.log",
    ".restore-uploads",
    ".restore-staging",
    ".restore.lock",
  ]);

  const { files, bytes } = copyDirRecursive(dataSource, dataTarget, skip);
  emit({ ok: true, files, bytes, source: dataSource, target: dataTarget });
}

async function applyEnv(staging: string) {
  // Search for an .env file at the top of staging or under any backed-up cwd.
  const targets: string[] = [];
  function findEnv(root: string, depth: number) {
    if (depth > 6) return;
    const direct = path.join(root, ".env");
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
      targets.push(direct);
      return;
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      findEnv(path.join(root, entry.name), depth + 1);
    }
  }
  findEnv(staging, 0);

  if (targets.length === 0) {
    emit({ ok: true, skipped: true, reason: "no .env in backup" });
    return;
  }

  // Prefer an .env adjacent to a package.json (project root) when multiple.
  const preferred = targets.find((p) => fs.existsSync(path.join(path.dirname(p), "package.json"))) ?? targets[0];
  const dst = path.join(process.cwd(), ".env");
  fs.copyFileSync(preferred, dst);
  const bytes = fs.statSync(dst).size;
  emit({ ok: true, source: preferred, target: dst, bytes });
}

async function applyHome(staging: string, oldHome: string | undefined) {
  if (!oldHome) {
    emit({ ok: false, error: "missing --old-home argument" });
    process.exit(1);
  }
  const targetHome = os.homedir();
  const oldHomeKey = oldHome.replace(/^\/+/, "").replace(/\/+$/, "");
  const stagingHomeRoot = path.join(staging, oldHomeKey);

  if (!fs.existsSync(stagingHomeRoot)) {
    emit({ ok: true, skipped: true, reason: `staging missing old-home prefix '${oldHomeKey}'` });
    return;
  }

  const restored: Array<{ source: string; target: string; bytes: number }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  await walkAndPlan(stagingHomeRoot, targetHome, restored, skipped, true, false);

  emit({
    ok: true,
    restoredCount: restored.length,
    skippedCount: skipped.length,
    bytes: restored.reduce((sum, r) => sum + r.bytes, 0),
    source: stagingHomeRoot,
    target: targetHome,
  });
}

async function main() {
  const { mode, staging, oldHome } = parseArgs();
  if (!mode || !staging) {
    process.stderr.write("Usage: restore-apply.ts <data|env|home> --staging <dir> [--old-home <key>]\n");
    process.exit(2);
  }
  if (!fs.existsSync(staging)) {
    emit({ ok: false, error: `staging dir not found: ${staging}` });
    process.exit(1);
  }
  try {
    if (mode === "data") await applyData(staging);
    else if (mode === "env") await applyEnv(staging);
    else if (mode === "home") await applyHome(staging, oldHome);
    else {
      emit({ ok: false, error: `unknown mode: ${mode}` });
      process.exit(2);
    }
  } catch (err) {
    emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main();
