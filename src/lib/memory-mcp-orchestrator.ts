/**
 * One-shot activation flow for the atlasdeck-memory MCP server.
 *
 * Glue between three pieces that already exist:
 *   1. installMcpServer()  — write the entry into ~/.openclaw/mcp.json
 *   2. restartGateway()    — pick whichever restart strategy works
 *                            (systemd → pm2 → /proc respawn)
 *   3. waitForGateway()    — TCP-probe the gateway port until it
 *                            comes back, so we don't report "ready"
 *                            while it's still booting.
 *
 * Each step is reported separately so the UI can show progress.
 * The function never throws — every failure becomes a structured
 * field in the result. Designed to be safe to call from a layperson
 * clicking a single button.
 */
import { listMemories } from "@/lib/memory-db";
import {
  inspectStatus,
  installMcpServer,
  type InstallResult,
  type InstallStatus,
} from "@/lib/openclaw-mcp-config";
import { restartGateway, type RestartResult } from "@/lib/gateway-control";
import { waitForGateway, type WaitResult } from "@/lib/openclaw-gateway-wait";

export interface ActivateOptions {
  agentId?: string;
  /** Skip the restart step. Useful when the caller knows the gateway
   *  is about to be restarted by something else, or when only the
   *  config file should be touched. Default false. */
  skipRestart?: boolean;
  /** Skip the post-restart wait. Default false. */
  skipWait?: boolean;
  /** TCP-probe timeout, in milliseconds. Default 15s. */
  waitTimeoutMs?: number;
}

export interface ActivateResult {
  ok: boolean;
  status: InstallStatus;
  install: InstallResult;
  restart: RestartResult | { skipped: true };
  wait: WaitResult | { skipped: true };
  agentSavedCount: number;
  reloadedToolsLikelyVisible: boolean;
  summary: string;
}

function describeRestart(r: RestartResult | { skipped: true }): string {
  if ("skipped" in r) return "reload pulado";
  return r.success ? `reload via ${r.runtime}` : `reload falhou (${r.runtime})`;
}

function describeWait(w: WaitResult | { skipped: true }): string {
  if ("skipped" in w) return "wait pulado";
  if (w.ready) return `gateway pronto em ${w.elapsedMs}ms`;
  return `gateway não voltou em ${w.elapsedMs}ms`;
}

export async function activateMemoryMcp(
  opts: ActivateOptions = {},
): Promise<ActivateResult> {
  const atlasdeckRoot = process.cwd();
  const agentId = opts.agentId ?? "main";

  const install = installMcpServer({ atlasdeckRoot, agentId });

  // If the config file was untouched (already up to date), the
  // restart might still be needed in case the gateway booted before
  // mcp.json was written. We restart anyway when written=true; when
  // written=false we assume the gateway has already seen it.
  let restart: RestartResult | { skipped: true };
  if (opts.skipRestart || !install.written) {
    restart = { skipped: true };
  } else {
    restart = await restartGateway();
  }

  let wait: WaitResult | { skipped: true };
  if (opts.skipWait || "skipped" in restart || !restart.success) {
    wait = { skipped: true };
  } else {
    wait = await waitForGateway({ timeoutMs: opts.waitTimeoutMs ?? 15_000 });
  }

  // Re-inspect after the dust settles so the UI sees the final
  // state (installed/upToDate) without an extra round-trip.
  const status = inspectStatus({ atlasdeckRoot, agentId });

  const { total: agentSavedCount } = listMemories({
    source: "agent",
    limit: 1,
  });

  // Tools are visible to the agent iff: the entry is installed AND
  // either we successfully restarted (and waited) OR we didn't need
  // to restart because the config was already up-to-date when the
  // gateway last booted.
  const reloadedToolsLikelyVisible =
    status.installed &&
    status.upToDate &&
    (("skipped" in restart) ||
      (restart.success && ("skipped" in wait || wait.ready)));

  const summary = [
    install.written
      ? install.before
        ? "config atualizada"
        : "config criada"
      : "config já estava certa",
    describeRestart(restart),
    describeWait(wait),
  ].join(" · ");

  return {
    ok: reloadedToolsLikelyVisible,
    status,
    install,
    restart,
    wait,
    agentSavedCount,
    reloadedToolsLikelyVisible,
    summary,
  };
}

/**
 * Silent boot-time install: writes the entry if missing or stale,
 * never restarts the gateway. Safe to call from instrumentation.ts.
 * Returns whether the install actually changed anything so callers
 * can decide whether to surface a "needs reload" hint.
 */
export function ensureMemoryMcpInstalledQuiet(opts: {
  agentId?: string;
}): { ok: true; changed: boolean; status: InstallStatus } | { ok: false; error: string } {
  try {
    const atlasdeckRoot = process.cwd();
    const agentId = opts.agentId ?? "main";
    const result = installMcpServer({ atlasdeckRoot, agentId });
    const status = inspectStatus({ atlasdeckRoot, agentId });
    return { ok: true, changed: result.written, status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
