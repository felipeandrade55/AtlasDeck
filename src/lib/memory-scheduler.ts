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
import {
  getSettings,
  setSettings,
  archiveLowImportance,
  reviewProbationExpired,
  getStats,
} from "@/lib/memory-db";
import { extractRecentSessions } from "@/lib/memory-extractor";
import { injectAllWorkspaces } from "@/lib/memory-injector";
import { addNotification } from "@/lib/notifications";
import { getOllamaStatus } from "@/lib/ollama-client";

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

async function maybeShowWelcomeNotification(): Promise<void> {
  try {
    const settings = getSettings();
    if (settings.welcome_notification_shown) return;

    const stats = getStats();
    // Show only on a truly fresh install (no memories yet). Avoids
    // surprising notifications on existing instances that upgrade.
    if (stats.total > 0) {
      setSettings({ welcome_notification_shown: true });
      return;
    }

    const ollama = await getOllamaStatus().catch(() => null);
    const ollamaHint = !ollama || !ollama.installed
      ? "Dica: ative Ollama para zero custo (instruções no guia)."
      : ollama.running
      ? "Ollama detectado e rodando — pronto pra entrevista."
      : "Ollama instalado mas parado — confira o status no guia.";

    const message = [
      "Abra o guia completo para conhecer o sistema menu por menu, fazer o setup da memória adaptativa e personalizar a identidade do seu agente.",
      "",
      ollamaHint,
    ].join("\n");

    await addNotification(
      "👋 Comece por aqui — guia de boas-vindas",
      message,
      "info",
      "/welcome",
      { source: "memory-onboarding" },
    );

    setSettings({ welcome_notification_shown: true });

    if (process.env.MEMORY_DEBUG === "1") {
      console.log("[memory-scheduler] welcome notification posted");
    }
  } catch (err) {
    console.warn("[memory-scheduler] welcome notification failed:", err);
  }
}

/**
 * Nudge users who chose "decide later" in the LLM-choice step. Fires
 * once per boot if the wizard recorded a deferred choice and the user
 * still hasn't picked a real provider. Identified by metadata.source
 * so we never queue more than one of these.
 */
async function maybeNudgeDeferredLLMChoice(): Promise<void> {
  try {
    const settings = getSettings();
    // Only nudge when: user opened the wizard, chose "later", and the
    // active extractor is still the default heuristic-ish openclaw with
    // no openclaw binary actually working. Conservative — skip if they
    // already configured something.
    if (!settings.llm_choice_made) return;

    const ollama = await getOllamaStatus().catch(() => null);
    const ollamaReady = ollama?.installed && ollama?.running;
    const usingOllama = settings.extractor_provider === "ollama";
    const usingOpenClaw = settings.extractor_provider === "openclaw";

    // If user picked Ollama and it's actually running, nothing to nudge.
    if (usingOllama && ollamaReady) return;
    // If user picked OpenClaw, trust the choice (we can't easily probe
    // the CLI without spawning it). Don't nag.
    if (usingOpenClaw) return;

    // Anything else means: chose "later" (or chose Ollama but it's not
    // ready). Drop a friendly reminder once per boot.
    const { loadNotifications } = await import("@/lib/notifications");
    const existing = await loadNotifications();
    const already = existing.some(
      (n) =>
        n.metadata &&
        (n.metadata as { source?: string }).source === "llm-choice-nudge",
    );
    if (already) return;

    await addNotification(
      "💡 Configure a LLM para liberar a memória adaptativa",
      [
        "Você ainda não escolheu uma LLM para o AtlasDeck. A memória adaptativa fica parada até você configurar.",
        "",
        "Ollama (local, grátis) é o caminho recomendado pra começar sem custo. Abra o wizard em Memória → Setup.",
      ].join("\n"),
      "info",
      "/memory",
      { source: "llm-choice-nudge" },
    );

    if (process.env.MEMORY_DEBUG === "1") {
      console.log("[memory-scheduler] LLM-choice nudge posted");
    }
  } catch (err) {
    console.warn("[memory-scheduler] LLM-choice nudge failed:", err);
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

  // Welcome notification: fires once per fresh install, off the hot
  // path. Doesn't block the scheduler boot.
  setTimeout(() => {
    void maybeShowWelcomeNotification();
    void maybeNudgeDeferredLLMChoice();
  }, 5_000);

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
