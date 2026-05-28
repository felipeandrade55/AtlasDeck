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
import {
  injectIntoWorkspace,
  type InjectionResult,
} from "@/lib/memory-injector";

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
  inject: InjectionResult | { skipped: true; error?: string };
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

  // Push the tool-usage guidance into the workspace MEMORY.md before
  // restarting — the agent reads that file on boot. Without this the
  // LLM tends to "remember" things from session context and skip the
  // tool entirely, which leaves the SQLite store empty even though
  // the user feels remembered.
  const workspace = agentId === "main" ? "workspace" : `workspace-${agentId}`;
  let inject: InjectionResult | { skipped: true; error?: string };
  try {
    inject = await injectIntoWorkspace(workspace, { maxMemories: 20 });
  } catch (err) {
    // Injection failure shouldn't block activation — the auto-recall
    // is a nice-to-have, the MCP tools are the load-bearing part.
    inject = { skipped: true, error: err instanceof Error ? err.message : String(err) };
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[memory-mcp-orchestrator] inject failed:", err);
    }
  }

  // Restart if EITHER the mcp.json changed OR the MEMORY.md changed.
  // Previously we only checked install.written — that left a hole:
  // when the user clicked Reverificar after we'd shipped a new
  // TOOL_GUIDANCE block, the config was already up to date but the
  // freshly-rewritten MEMORY.md was never reread by the running
  // gateway, so the agent kept ignoring the memory tools.
  const injectionChanged = "changed" in inject && inject.changed;
  const needsRestart = install.written || injectionChanged;
  let restart: RestartResult | { skipped: true };
  if (opts.skipRestart || !needsRestart) {
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
    injectionChanged
      ? "MEMORY.md atualizado"
      : "skipped" in inject
      ? "inject pulado"
      : "MEMORY.md já estava certo",
    describeRestart(restart),
    describeWait(wait),
  ].join(" · ");

  return {
    ok: reloadedToolsLikelyVisible,
    status,
    install,
    inject,
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
 *
 * `skipIfOpenClawMissing` (default false) lets the boot hook avoid
 * writing a stub directory tree on machines where OpenClaw isn't
 * installed at all — instrumentation.ts uses this so we don't ship
 * `fs` imports up into the (edge-eligible) `instrumentation.ts`
 * source itself.
 */
export function ensureMemoryMcpInstalledQuiet(opts: {
  agentId?: string;
  skipIfOpenClawMissing?: boolean;
}): { ok: true; changed: boolean; status: InstallStatus } | { ok: false; error: string } {
  try {
    if (opts.skipIfOpenClawMissing) {
      // Lazy require so this file remains import-safe in edge bundles;
      // the actual fs hit only happens when this function is called
      // on the Node.js runtime.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs") as typeof import("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOpenClawDir } = require("@/lib/openclaw-config") as typeof import("@/lib/openclaw-config");
      if (!fs.existsSync(getOpenClawDir())) {
        return { ok: true, changed: false, status: inspectStatus({ atlasdeckRoot: process.cwd(), agentId: opts.agentId ?? "main" }) };
      }
    }
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
