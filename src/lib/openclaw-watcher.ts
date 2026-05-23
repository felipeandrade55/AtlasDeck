/**
 * Background watcher that imports OpenClaw JSONL sessions into the
 * AtlasDeck chat database (and Mission Control activity log) the moment
 * they change on disk.
 *
 * Layered for robustness:
 *   1. `fs.watch` on each `agents/<id>/sessions` directory — kernel-level
 *      events, zero CPU when idle. We also watch the top-level `agents`
 *      directory so newly created agents pick up watchers automatically.
 *   2. 800ms debounce — OpenClaw writes JSONL line-by-line, so a single
 *      reply may emit 20+ `change` events. We coalesce them into one
 *      import pass.
 *   3. 60-second poll fallback — covers FS oddities where `fs.watch`
 *      misses events (network mounts, some container filesystems).
 *   4. Single-flight guard — if an import is already running, subsequent
 *      triggers are dropped (the next debounce tick will pick them up).
 *
 * Started once per Node process from `src/instrumentation.ts`.
 */
import { existsSync, readdirSync, watch, type FSWatcher } from "fs";
import path from "path";
import { readOpenClawConfig } from "./openclaw-config";
import { importOpenClawSessions } from "./openclaw-sessions-bridge";

const DEBOUNCE_MS = 800;
const POLL_INTERVAL_MS = 60_000;

let started = false;
let running = false;
let debounceTimer: NodeJS.Timeout | null = null;
const watchers: FSWatcher[] = [];

function runImport(reason: string): void {
  if (running) return;
  running = true;
  try {
    const summary = importOpenClawSessions();
    if (summary.imported > 0 || summary.failed > 0) {
      console.log(
        `[openclaw-watcher] ${reason}: imported=${summary.imported} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    }
  } catch (err) {
    console.warn("[openclaw-watcher] import failed:", err);
  } finally {
    running = false;
  }
}

function schedule(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runImport(reason), DEBOUNCE_MS);
}

function bindSessionWatchers(agentsDir: string): void {
  // Close any prior session watchers (the top-level agents watcher
  // rebinds when an agent dir is created/removed).
  for (const w of watchers.splice(0)) {
    try {
      w.close();
    } catch {}
  }

  let agents: string[];
  try {
    agents = readdirSync(agentsDir);
  } catch {
    return;
  }

  for (const agentId of agents) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;
    try {
      const w = watch(sessionsDir, { persistent: false }, () =>
        schedule(`change in ${agentId}/sessions`),
      );
      watchers.push(w);
    } catch (err) {
      console.warn(`[openclaw-watcher] watch failed for ${sessionsDir}:`, err);
    }
  }
}

export function startOpenClawWatcher(): void {
  if (started) return;
  started = true;

  let agentsDir: string;
  try {
    agentsDir = path.join(readOpenClawConfig().openclawDir, "agents");
  } catch (err) {
    console.warn("[openclaw-watcher] readOpenClawConfig failed:", err);
    // Fallback: poll-only. The config may become valid later.
    setInterval(() => runImport("poll"), POLL_INTERVAL_MS).unref();
    return;
  }

  if (!existsSync(agentsDir)) {
    console.warn(`[openclaw-watcher] agents dir not found: ${agentsDir}`);
    setInterval(() => runImport("poll"), POLL_INTERVAL_MS).unref();
    return;
  }

  bindSessionWatchers(agentsDir);

  // Watch the agents dir itself so newly created agents pick up
  // session watchers without restarting the server.
  try {
    const top = watch(agentsDir, { persistent: false }, () => {
      bindSessionWatchers(agentsDir);
      schedule("agents dir changed");
    });
    watchers.push(top);
  } catch (err) {
    console.warn(`[openclaw-watcher] watch failed for ${agentsDir}:`, err);
  }

  // Safety net for filesystems where fs.watch is unreliable.
  setInterval(() => runImport("poll"), POLL_INTERVAL_MS).unref();

  // Catch anything that happened while the server was down.
  schedule("startup");

  console.log(`[openclaw-watcher] started (watching ${agentsDir})`);
}
