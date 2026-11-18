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
  archiveHeuristicExtractions,
  backupMemoriesDb,
  countMemoriesNeedingEmbedding,
  getSettingValue,
  setSettingValue,
  startJob,
  finishJob,
} from "@/lib/memory-db";
import {
  extractRecentConversations,
  runBackfillSlice,
  ENGINE_V2_STARTED_AT_KEY,
  type ExtractionRoundResult,
} from "@/lib/memory-extractor";
import { injectAllWorkspaces } from "@/lib/memory-injector";
import { reembedPending } from "@/lib/memory-service";
import { isEmbeddingReady } from "@/lib/embeddings";
import { maybeRunReflection, curateLegacyMemories } from "@/lib/reflection-job";
import { isAgentBusy } from "@/lib/agent-activity";
import { getOneShotStatus, isOneShotAvailable } from "@/lib/llm-oneshot";
import { addNotification } from "@/lib/notifications";
import { getOllamaStatus } from "@/lib/ollama-client";

// Short interval: each round only does work for threads that went quiet
// (≥90s without messages) and stops as soon as the user is active again.
const EXTRACTION_INTERVAL_MS = Number.parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || `${3 * 60 * 1000}`,
  10,
);
const EXTRACTION_MAX_BATCHES = Number.parseInt(process.env.MEMORY_EXTRACTION_MAX_BATCHES || "6", 10);
const REEMBED_INTERVAL_MS = 2 * 60 * 1000;
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
let reembedTimer: NodeJS.Timeout | null = null;

let extractionRunning = false;
let injectionRunning = false;
let housekeepRunning = false;
let reembedRunning = false;
let breakerNotified = false;

const MIGRATION_V2_KEY = "memory_engine_v2_migrated";

/**
 * One-time move to the v2 engine:
 *   1. online backup of memories.db;
 *   2. archive (never delete) the "Usuário pediu: …" heuristic rows;
 *   3. record the engine start — conversations idle since before it are
 *      left to the explicit 90-day backfill instead of being re-billed by
 *      the regular rounds.
 * Re-embedding with the multilingual model happens incrementally in the
 * reembed job.
 */
export async function runEngineV2Migration(): Promise<void> {
  if (getSettingValue(MIGRATION_V2_KEY)) return;
  const jobId = startJob("migration-v2");
  try {
    const backup = await backupMemoriesDb("pre-v2");
    const archived = archiveHeuristicExtractions();
    // Owner's choice: background LLM = OpenClaw subscription (no Ollama).
    // The setting now only steers the onboarding wizard.
    setSettings({ extractor_provider: "openclaw" });
    if (!getSettingValue(ENGINE_V2_STARTED_AT_KEY)) {
      setSettingValue(ENGINE_V2_STARTED_AT_KEY, new Date().toISOString());
    }
    setSettingValue(MIGRATION_V2_KEY, new Date().toISOString());
    finishJob(jobId, "ok", {
      detail: `backup=${backup} heuristicas_arquivadas=${archived} reembed_pendente=${countMemoriesNeedingEmbedding()}`,
    });
    console.log(`[memory-scheduler] v2 migration done (archived ${archived} heuristic rows, backup ${backup})`);
  } catch (err) {
    finishJob(jobId, "failed", { error: err instanceof Error ? err.message : String(err) });
    console.warn("[memory-scheduler] v2 migration failed:", err);
  }
}

async function runExtraction(): Promise<ExtractionRoundResult | null> {
  if (extractionRunning) return null;
  extractionRunning = true;
  try {
    const settings = getSettings();
    if (!settings.extraction_enabled) return null;
    await runEngineV2Migration();
    const result = await extractRecentConversations({ maxBatches: EXTRACTION_MAX_BATCHES });
    // Historic backfill only uses what's left of the round's budget, so
    // live conversations are always learned first.
    if (result.stoppedReason === "done") {
      const slice = await runBackfillSlice(Math.max(1, EXTRACTION_MAX_BATCHES - result.batches));
      if (slice.batches > 0) console.log(`[memory-scheduler] backfill: +${slice.batches} lote(s)${slice.done ? " — concluído" : ""}`);
      // Then, one curation batch of legacy memories per idle round.
      if (slice.done && !(await isAgentBusy()) && isOneShotAvailable()) {
        const jobId = startJob("curate");
        try {
          const cur = await curateLegacyMemories();
          if (cur) {
            finishJob(jobId, "ok", { detail: `revisadas=${cur.reviewed} arquivadas=${cur.archived}` });
            console.log(`[memory-scheduler] curadoria: ${cur.reviewed} revisadas, ${cur.archived} arquivadas`);
          } else {
            finishJob(jobId, "skipped", { detail: "nada a revisar" });
          }
        } catch (err) {
          finishJob(jobId, "failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (process.env.MEMORY_DEBUG === "1" || result.batches > 0) {
      console.log(
        `[memory-scheduler] extraction: threads=${result.threadsConsidered} batches=${result.batches} +${result.created} ~${result.updated} ⇄${result.superseded} failed=${result.failed} stop=${result.stoppedReason}`,
      );
    }
    await maybeNotifyExtractorDown();
    return result;
  } catch (err) {
    console.warn("[memory-scheduler] extraction failed:", err);
    return null;
  } finally {
    extractionRunning = false;
  }
}

/** Surface a broken extractor in the UI once per outage (no more silent failure). */
async function maybeNotifyExtractorDown(): Promise<void> {
  const status = getOneShotStatus();
  if (!status.breakerOpen) {
    breakerNotified = false;
    return;
  }
  if (breakerNotified) return;
  breakerNotified = true;
  try {
    await addNotification(
      "⚠️ Memória: extrator sem acesso ao modelo",
      [
        "O AtlasDeck não conseguiu chamar o modelo pelo OpenClaw para aprender com as conversas.",
        "As conversas continuam guardadas e serão processadas quando o acesso voltar.",
        "",
        `Último erro: ${(status.lastError ?? "desconhecido").slice(0, 400)}`,
      ].join("\n"),
      "warning",
      "/memory",
      { source: "memory-extractor-breaker" },
    );
  } catch {
    /* notifications are best-effort */
  }
}

async function runReembed(): Promise<void> {
  if (reembedRunning) return;
  reembedRunning = true;
  try {
    if (countMemoriesNeedingEmbedding() === 0) return;
    const { done, failed } = await reembedPending(25);
    if (process.env.MEMORY_DEBUG === "1" || failed > 0) {
      console.log(`[memory-scheduler] reembed: done=${done} failed=${failed}`);
    }
  } catch (err) {
    console.warn("[memory-scheduler] reembed failed:", err);
  } finally {
    reembedRunning = false;
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
    await maybeRunReflection().catch((err) =>
      console.warn("[memory-scheduler] reflection failed:", err instanceof Error ? err.message : err),
    );
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

    // If the user already finished the 1-click setup wizard there's no
    // reason to nag them. Mark as shown so older installs that upgrade
    // post-setup skip the notification quietly.
    if (settings.setup_completed_at) {
      setSettings({ welcome_notification_shown: true });
      return;
    }

    const ollama = await getOllamaStatus().catch(() => null);
    const ollamaHint = !ollama || !ollama.installed
      ? "Sem Ollama? Sem problema — o wizard também conecta um modelo cloud (Anthropic / OpenAI / Google) em 1 passo."
      : ollama.running
      ? "Ollama detectado e rodando — pode escolher rodar tudo local, gratuito."
      : "Ollama instalado mas parado — o wizard ajuda a religar.";

    const message = [
      "Abra /welcome para fazer a instalação em 5 passos: OpenClaw → modelo de IA → personalidade → Telegram → pronto.",
      "",
      ollamaHint,
    ].join("\n");

    await addNotification(
      "👋 Vamos instalar seu AtlasDeck em 5 passos",
      message,
      "info",
      "/welcome",
      { source: "setup-wizard" },
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

  // Load (and on first boot, download) the embedding model early, off the
  // request path — otherwise the first memory writes after a deploy time
  // out and are saved without vectors until the reembed job catches up.
  setTimeout(() => {
    void isEmbeddingReady().then((ok) => {
      if (!ok) console.warn("[memory-scheduler] embedding model not available — semantic search degraded to keyword");
    });
  }, 10_000);

  // Kick off with a short delay so we don't race the server boot
  setTimeout(() => {
    void runExtraction();
    void runInjection();
    void runHousekeep();
    void runReembed();
  }, 30_000);

  extractionTimer = setInterval(() => void runExtraction(), EXTRACTION_INTERVAL_MS);
  injectionTimer = setInterval(runInjection, INJECTION_INTERVAL_MS);
  housekeepTimer = setInterval(runHousekeep, HOUSEKEEP_INTERVAL_MS);
  reembedTimer = setInterval(runReembed, REEMBED_INTERVAL_MS);

  // Avoid the timers preventing graceful shutdown
  extractionTimer.unref?.();
  injectionTimer.unref?.();
  housekeepTimer.unref?.();
  reembedTimer.unref?.();

  console.log(
    `[memory-scheduler] started (extract=${Math.round(EXTRACTION_INTERVAL_MS / 1000)}s, inject=${Math.round(INJECTION_INTERVAL_MS / 1000)}s, housekeep=${Math.round(HOUSEKEEP_INTERVAL_MS / 1000)}s)`,
  );
}

export function stopMemoryScheduler(): void {
  if (extractionTimer) clearInterval(extractionTimer);
  if (injectionTimer) clearInterval(injectionTimer);
  if (housekeepTimer) clearInterval(housekeepTimer);
  if (reembedTimer) clearInterval(reembedTimer);
  extractionTimer = null;
  injectionTimer = null;
  housekeepTimer = null;
  reembedTimer = null;
  started = false;
}

/** Force-run all jobs once. Used by the manual API endpoints. */
export async function runAllJobsOnce(): Promise<{
  extraction: ExtractionRoundResult;
  injectionWorkspaces: number;
  housekeepArchived: number;
}> {
  await runEngineV2Migration();
  const extraction = await extractRecentConversations({ maxBatches: EXTRACTION_MAX_BATCHES, force: true });
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
