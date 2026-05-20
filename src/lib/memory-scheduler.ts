/**
 * In-process scheduler for the memory subsystem.
 *
 * Boots from instrumentation.ts (Next.js native server-startup hook).
 * Runs three periodic jobs:
 *   - extraction: every N min, pulls new exchanges from session JSONLs
 *   - injection:  every M min, regenerates AUTO_RECALL block in MEMORY.md
 *   - housekeep:  hourly, archives low-importance stale memories
 *
 * Designed to be safe even when nothing is configured: jobs skip silently
 * if there are no sessions or no memories yet. Kill-switch via the
 * MEMORY_SCHEDULER_DISABLED=1 env var.
 */
import { getSettings, archiveLowImportance, reviewProbationExpired } from "@/lib/memory-db";
import { extractRecentSessions } from "@/lib/memory-extractor";
import { injectAllWorkspaces } from "@/lib/memory-injector";

const EXTRACTION_INTERVAL_MS = Number.parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || `${15 * 60 * 1000}`,
  10,
);
const INJECTION_INTERVAL_MS = Number.parseInt(
  process.env.MEMORY_INJECTION_INTERVAL_MS || `${30 * 60 * 1000}`,
  10,
);
const HOUSEKEEP_INTERVAL_MS = Number.parseInt(
  process.env.MEMORY_HOUSEKEEP_INTERVAL_MS || `${60 * 60 * 1000}`,
  10,
);

let extractionTimer: NodeJS.Timeout | null = null;
let injectionTimer: NodeJS.Timeout | null = null;
let housekeepTimer: NodeJS.Timeout | null = null;

let extractionRunning = false;
let injectionRunning = false;
let housekeepRunning = false;

async function runExtraction(): Promise<void> {
  if (extractionRunning) return;
  extractionRunning = true;
  try {
    const settings = getSettings();
    if (!settings.extraction_enabled) return;
    const result = await extractRecentSessions({
      maxSessions: 20,
      batchExchanges: 6,
      useLLM: true,
    });
    if (process.env.MEMORY_DEBUG === "1") {
      console.log(
        `[memory-scheduler] extraction: sessions=${result.sessionsProcessed} extracted=${result.extracted} linked=${result.linked} skipped=${result.skipped} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.warn("[memory-scheduler] extraction failed:", err);
  } finally {
    extractionRunning = false;
  }
}

async function runInjection(): Promise<void> {
  if (injectionRunning) return;
  injectionRunning = true;
  try {
    const settings = getSettings();
    if (!settings.inject_into_memory_md) return;
    const results = await injectAllWorkspaces({ maxMemories: 20 });
    if (process.env.MEMORY_DEBUG === "1") {
      console.log(
        `[memory-scheduler] injection: workspaces=${results.length} changed=${results.filter((r) => r.changed).length}`,
      );
    }
  } catch (err) {
    console.warn("[memory-scheduler] injection failed:", err);
  } finally {
    injectionRunning = false;
  }
}

async function runHousekeep(): Promise<void> {
  if (housekeepRunning) return;
  housekeepRunning = true;
  try {
    const settings = getSettings();
    const archived = archiveLowImportance(
      settings.forgetting_threshold,
      settings.forgetting_age_days,
    );
    const probation = reviewProbationExpired();
    if (process.env.MEMORY_DEBUG === "1") {
      console.log(
        `[memory-scheduler] housekeep: archived=${archived} probation_promoted=${probation.promoted} probation_archived=${probation.archived}`,
      );
    }
  } catch (err) {
    console.warn("[memory-scheduler] housekeep failed:", err);
  } finally {
    housekeepRunning = false;
  }
}

let started = false;

export function startMemoryScheduler(): void {
  if (started) return;
  if (process.env.MEMORY_SCHEDULER_DISABLED === "1") {
    console.log("[memory-scheduler] disabled by MEMORY_SCHEDULER_DISABLED=1");
    return;
  }
  started = true;

  // Kick off with a short delay so we don't race the server boot
  setTimeout(() => {
    void runExtraction();
    void runInjection();
    void runHousekeep();
  }, 30_000);

  extractionTimer = setInterval(runExtraction, EXTRACTION_INTERVAL_MS);
  injectionTimer = setInterval(runInjection, INJECTION_INTERVAL_MS);
  housekeepTimer = setInterval(runHousekeep, HOUSEKEEP_INTERVAL_MS);

  // Avoid the timers preventing graceful shutdown
  extractionTimer.unref?.();
  injectionTimer.unref?.();
  housekeepTimer.unref?.();

  console.log(
    `[memory-scheduler] started (extract=${Math.round(EXTRACTION_INTERVAL_MS / 1000)}s, inject=${Math.round(INJECTION_INTERVAL_MS / 1000)}s, housekeep=${Math.round(HOUSEKEEP_INTERVAL_MS / 1000)}s)`,
  );
}

export function stopMemoryScheduler(): void {
  if (extractionTimer) clearInterval(extractionTimer);
  if (injectionTimer) clearInterval(injectionTimer);
  if (housekeepTimer) clearInterval(housekeepTimer);
  extractionTimer = null;
  injectionTimer = null;
  housekeepTimer = null;
  started = false;
}

/** Force-run all jobs once. Used by the manual API endpoints. */
export async function runAllJobsOnce(): Promise<{
  extraction: Awaited<ReturnType<typeof extractRecentSessions>>;
  injectionWorkspaces: number;
  housekeepArchived: number;
}> {
  const extraction = await extractRecentSessions({
    maxSessions: 20,
    batchExchanges: 6,
    useLLM: true,
  });
  const injection = await injectAllWorkspaces({ maxMemories: 20 });
  const settings = getSettings();
  const archived = archiveLowImportance(
    settings.forgetting_threshold,
    settings.forgetting_age_days,
  );
  reviewProbationExpired();
  return {
    extraction,
    injectionWorkspaces: injection.filter((r) => r.changed).length,
    housekeepArchived: archived,
  };
}
