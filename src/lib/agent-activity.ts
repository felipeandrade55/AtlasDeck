/**
 * "Is the agent busy right now?" — cheap heuristic used by background
 * memory jobs that share the gateway with the user-facing bot.
 *
 * The memory LLM runs on the same OpenClaw subscription as the bot
 * (owner's choice: no separate API key). With the Codex harness every
 * call blocks the gateway's event loop for seconds, so we only run
 * background calls when nobody has talked to an agent recently.
 *
 * Signals (any one = busy):
 *   - a session transcript / agent store under agents/<id>/ was written
 *     in the last `windowMs` (covers both the legacy JSONL sessions and
 *     the SQLite store, whose -wal file changes on every write);
 *   - the web chat route reported a turn in the last `windowMs`.
 */
import { promises as fs } from "fs";
import path from "path";
import { readOpenClawConfig } from "@/lib/openclaw-config";

let lastWebTurnAt = 0;
/** Writes up to this instant were caused by our own background LLM calls
 *  (e.g. the `openclaw agent` fallback creates a transcript) and must not
 *  count as the user being active, or the extractor would block itself. */
let selfActivityUntil = 0;

/** Called by the web chat route at the start/end of each turn. */
export function markWebChatActivity(): void {
  lastWebTurnAt = Date.now();
}

export function markSelfActivity(untilMs = Date.now()): void {
  selfActivityUntil = Math.max(selfActivityUntil, untilMs + 3_000);
  cache = null;
}

async function newestMtime(dir: string, depth: number): Promise<number> {
  let newest = 0;
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) newest = Math.max(newest, await newestMtime(full, depth - 1));
      continue;
    }
    if (!/\.(jsonl|sqlite|sqlite-wal|db|db-wal)$/i.test(entry.name)) continue;
    try {
      const st = await fs.stat(full);
      newest = Math.max(newest, st.mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return newest;
}

let cache: { at: number; newest: number } | null = null;

/** Most recent write to any agent transcript/store (ms epoch), cached 10s. */
export async function lastAgentActivityAt(): Promise<number> {
  if (cache && Date.now() - cache.at < 10_000) return Math.max(cache.newest, lastWebTurnAt);
  let newest = 0;
  try {
    const agentsDir = path.join(readOpenClawConfig().openclawDir, "agents");
    const agents = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const base = path.join(agentsDir, a.name);
      // agents/<id>/sessions/*.jsonl and agents/<id>/agent/*.sqlite(-wal)
      newest = Math.max(
        newest,
        await newestMtime(path.join(base, "sessions"), 0),
        await newestMtime(path.join(base, "agent"), 0),
      );
    }
  } catch {
    /* no OpenClaw dir (dev) — only web activity counts */
  }
  cache = { at: Date.now(), newest };
  return Math.max(newest, lastWebTurnAt);
}

export async function isAgentBusy(windowMs = 60_000): Promise<boolean> {
  const newest = await lastAgentActivityAt();
  if (newest <= selfActivityUntil && lastWebTurnAt <= selfActivityUntil) return false;
  return Date.now() - newest < windowMs;
}
