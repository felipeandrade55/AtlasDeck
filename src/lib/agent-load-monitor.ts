/**
 * Agent load monitor — parses the last N lines of the gateway log to
 * infer how close the Codex/embedded agent is to a context-overflow
 * timeout. Tracks two signals that the gateway already emits today:
 *
 *   "[timeout-compaction] LLM timed out with high prompt token usage (NN%)"
 *   "[agent/embedded] codex app-server turn idle timed out"
 *
 * The output is a single severity bucket the diagnose card can render
 * without redoing the regex work and a hint string the user can act on.
 *
 * Why this lives separately from health-monitor / telegram-diagnostic:
 *   - Those probe the *channel* (webhook, polling, pending updates).
 *   - This probes the *agent's headroom* — a different failure mode that
 *     looks identical from the outside (bot silent) but needs a different
 *     fix (rotate the session, not restart the gateway).
 */

const TIMEOUT_PATTERN = /\[agent\/embedded\] codex app-server turn idle timed out/gi;
const COMPACTION_FAIL_PATTERN = /\[timeout-compaction\] compaction did not reduce context/gi;
const USAGE_PATTERN = /high prompt token usage \((\d+)%\)/gi;
const FAILOVER_SURFACE_PATTERN = /embedded run failover decision[^\n]*decision=surface_error[^\n]*reason=timeout/gi;

const JOURNALCTL_TS_PATTERN = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;
const ISO_TS_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?)/;
const INLINE_ISO_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?)/;

export type AgentLoadSeverity = "ok" | "warn" | "critical";

export interface AgentLoadSnapshot {
  /** Most recent usage % observed and when (epoch ms in local time). */
  latestUsage: { percent: number; at: number } | null;
  /** Count of "turn idle timed out" events in the inspection window. */
  recentTimeouts: number;
  /** Count of "compaction did not reduce context" events in the inspection window. */
  recentCompactionFailures: number;
  /** Count of failover decisions that gave up (surface_error reason=timeout). */
  recentSurfaceErrors: number;
  /** Compound bucket the UI renders as a traffic light. */
  severity: AgentLoadSeverity;
  /** One-line user-facing hint. Stable enough to render as-is. */
  hint: string;
  /** Window (ms) we considered for "recent" counts. */
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Parse a journalctl/iso timestamp at the start of a log line into epoch ms.
 * Returns null if no timestamp could be extracted — callers fall back to
 * "now" so a missing timestamp doesn't silently drop the event.
 *
 * The journalctl format ("May 29 12:27:57") doesn't carry a year, so we
 * pin it to the current year and roll the date back a year if that puts
 * the timestamp in the future (handles January boundary crossings).
 */
function parseLogTimestamp(line: string): number | null {
  const iso = line.match(ISO_TS_PATTERN) || line.match(INLINE_ISO_PATTERN);
  if (iso) {
    const t = Date.parse(iso[1]);
    return Number.isFinite(t) ? t : null;
  }
  const j = line.match(JOURNALCTL_TS_PATTERN);
  if (j) {
    const now = new Date();
    const candidate = new Date(`${j[1]} ${now.getFullYear()}`);
    const t = candidate.getTime();
    if (!Number.isFinite(t)) return null;
    // Future timestamp by more than 1 day → must belong to previous year
    if (t > now.getTime() + 24 * 3600 * 1000) {
      candidate.setFullYear(now.getFullYear() - 1);
      return candidate.getTime();
    }
    return t;
  }
  return null;
}

function countWithinWindow(
  logs: string,
  pattern: RegExp,
  cutoff: number,
): number {
  let count = 0;
  const lines = logs.split("\n");
  for (const line of lines) {
    pattern.lastIndex = 0;
    if (!pattern.test(line)) continue;
    const t = parseLogTimestamp(line);
    // If we couldn't parse a timestamp, count it — better to over-report
    // a known-recent-ish failure than to drop it silently.
    if (t === null || t >= cutoff) count++;
  }
  return count;
}

function findLatestUsage(logs: string): { percent: number; at: number } | null {
  let latest: { percent: number; at: number } | null = null;
  const lines = logs.split("\n");
  for (const line of lines) {
    USAGE_PATTERN.lastIndex = 0;
    const match = USAGE_PATTERN.exec(line);
    if (!match) continue;
    const percent = Number(match[1]);
    if (!Number.isFinite(percent)) continue;
    const at = parseLogTimestamp(line) ?? Date.now();
    if (!latest || at >= latest.at) latest = { percent, at };
  }
  return latest;
}

/**
 * Build the load snapshot from a logs blob. Pure function — no I/O —
 * so it composes cleanly into the diagnose route and into unit tests.
 */
export function snapshotAgentLoad(
  logsOutput: string | null,
  opts: { windowMs?: number; now?: number } = {},
): AgentLoadSnapshot {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowMs;

  if (!logsOutput) {
    return {
      latestUsage: null,
      recentTimeouts: 0,
      recentCompactionFailures: 0,
      recentSurfaceErrors: 0,
      severity: "ok",
      hint: "Sem logs de gateway pra inspecionar.",
      windowMs,
    };
  }

  const latestUsage = findLatestUsage(logsOutput);
  const recentTimeouts = countWithinWindow(logsOutput, TIMEOUT_PATTERN, cutoff);
  const recentCompactionFailures = countWithinWindow(
    logsOutput,
    COMPACTION_FAIL_PATTERN,
    cutoff,
  );
  const recentSurfaceErrors = countWithinWindow(
    logsOutput,
    FAILOVER_SURFACE_PATTERN,
    cutoff,
  );

  // Decide severity. Order matters: surface_error within the window is
  // *the* user-visible failure — bot stopped responding — so that wins.
  // Otherwise grade by usage %.
  //
  // We treat `latestUsage` as the *current* state of the session, even if
  // the log line is older than the recent-counts window: token usage is
  // monotonic within a single conversation, so if it was 77% an hour ago
  // and nothing has rotated the session since, the next message still
  // lands on a 77%-full prompt. We only down-rank stale usage if we can
  // see a session-fresh signal *after* it (handled by the caller via
  // session-rotator activity log, not here).
  let severity: AgentLoadSeverity = "ok";
  let hint = "Carga do agente saudável.";

  const usagePercent = latestUsage?.percent ?? 0;
  const hasUsage = latestUsage !== null;

  if (recentSurfaceErrors > 0) {
    severity = "critical";
    hint =
      "Agente abandonou turno recente por timeout. Recomendado: rotacionar a conversa agora.";
  } else if (recentTimeouts > 0 || recentCompactionFailures > 0) {
    severity = "critical";
    hint =
      "Timeouts recentes do Codex — a conversa atual já está estourando contexto. Rotacionar para evitar bot silencioso.";
  } else if (hasUsage && usagePercent >= 70) {
    // 70% is the empirically-observed danger zone — the prod timeouts
    // on 2026-05-29 fired at 70% and 77% prompt-token usage. Treat
    // anything ≥70 as critical so the auto-rotator can act before the
    // next message hits the wall.
    severity = "critical";
    hint = `Uso de prompt em ${usagePercent}% — próxima resposta tem alta chance de timeout. Rotacione a conversa.`;
  } else if (hasUsage && usagePercent >= 50) {
    severity = "warn";
    hint = `Uso de prompt em ${usagePercent}% — janela apertando. Considere rotacionar antes de uma conversa longa.`;
  }

  return {
    latestUsage,
    recentTimeouts,
    recentCompactionFailures,
    recentSurfaceErrors,
    severity,
    hint,
    windowMs,
  };
}
