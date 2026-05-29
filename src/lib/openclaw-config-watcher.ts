/**
 * fs.watch on <openclawDir>/openclaw.json. When the file changes, debounce
 * for 3s (let the writer finish) and then run sweepOpenClawConfig() so any
 * schema-rejected key gets stripped BEFORE the next gateway restart hits
 * its strict validator.
 *
 * Background: in production the user's VPS runs two products on the same
 * openclaw.json — AtlasDeck (this app) AND a separate jarvis-dashboard
 * product. The latter writes WhatsApp account fields the new OpenClaw
 * schema rejects with "must NOT have additional properties", which makes
 * `systemctl restart openclaw-gateway` crash-loop until the file is
 * sanitized. The boot-time sweep covers AtlasDeck's own boot path; this
 * watcher covers everything else (the jarvis-dashboard writes, gateway
 * persisting session state during WhatsApp pairing, manual jq edits).
 *
 * Notes on safety:
 *   - The sweep itself is idempotent — when nothing needs cleaning it
 *     doesn't touch the file, so we don't ping-pong with the gateway's
 *     own config-watcher.
 *   - When the sweep DOES write, we suppress our own next event for
 *     2× debounce to avoid re-triggering ourselves immediately.
 *   - fs.watch is best-effort: on some filesystems (NFS, FUSE) it doesn't
 *     fire reliably. The boot sweep + sweep-before-restart catches the
 *     case where the watcher missed the change.
 */
import { watch, type FSWatcher } from "fs";
import path from "path";
import { sweepOpenClawConfig } from "./openclaw-config-sweep";
import { OPENCLAW_DIR } from "./paths";

const DEBOUNCE_MS = 3000;
const SUPPRESS_AFTER_OWN_WRITE_MS = DEBOUNCE_MS * 2;

interface WatcherState {
  started: boolean;
  watcher: FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  lastOwnWriteAt: number;
  sweepsRun: number;
  sweepsThatChanged: number;
}

/**
 * Why globalThis-pinned state: Next.js bundles `instrumentation.ts` and each
 * API route as separate chunks. Without this, the module is duplicated and
 * the API route's `getOpenClawConfigWatcherStats()` reads a *different* state
 * object than the one `startOpenClawConfigWatcher()` mutated at boot — the
 * diagnose endpoint would always report `started: false` even though the
 * watcher is actually running. globalThis bypasses the chunk-level
 * deduplication and ensures every importer of this module sees the same
 * singleton.
 */
const STATE_KEY = "__atlasdeckOpenClawConfigWatcherState";
type GlobalWithState = typeof globalThis & {
  [STATE_KEY]?: WatcherState;
};
const globalRef = globalThis as GlobalWithState;
const state: WatcherState =
  globalRef[STATE_KEY] ??
  (globalRef[STATE_KEY] = {
    started: false,
    watcher: null,
    debounceTimer: null,
    lastOwnWriteAt: 0,
    sweepsRun: 0,
    sweepsThatChanged: 0,
  });

function runSweepNow(): void {
  // Ignore self-triggered events for a couple of debounce windows after we
  // wrote the file. Without this, our own write would re-fire the watcher
  // and we'd run the sweep again with nothing to do (cheap, but noisy logs).
  if (Date.now() - state.lastOwnWriteAt < SUPPRESS_AFTER_OWN_WRITE_MS) return;

  const r = sweepOpenClawConfig();
  state.sweepsRun++;
  if (!r.ran) {
    if (r.error) {
      console.warn(`[openclaw-config-watcher] sweep falhou: ${r.error}`);
    }
    return;
  }
  const cleaned: string[] = [];
  if (r.changedTelegram) cleaned.push("telegram");
  if (r.changedWhatsapp) cleaned.push("whatsapp");
  if (r.changedGatewayToolsAllow) cleaned.push("gateway.tools.allow");
  if (r.changedPluginsEnabled?.length > 0) {
    cleaned.push(`plugins.enabled (${r.changedPluginsEnabled.join("+")})`);
  }
  if (r.changedWhatsappChannelDefaults) cleaned.push("channels.whatsapp defaults");
  if (cleaned.length > 0) {
    state.sweepsThatChanged++;
    state.lastOwnWriteAt = Date.now();
    console.log(
      `[openclaw-config-watcher] openclaw.json mudou — sweep removeu campos proibidos em: ${cleaned.join(", ")}`,
    );
  }
}

function scheduleSweep(): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    try {
      runSweepNow();
    } catch (err) {
      console.warn("[openclaw-config-watcher] sweep threw:", err);
    }
  }, DEBOUNCE_MS);
  if (typeof state.debounceTimer.unref === "function") state.debounceTimer.unref();
}

export function startOpenClawConfigWatcher(): void {
  if (state.started) return;
  state.started = true;

  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");

  // Run sweep once on start (covers the case where the file was edited while
  // AtlasDeck was down — boot sweep also handles this but we mirror it here
  // so the watcher logging path is the single source of truth for "sweep
  // ran because of a config event").
  scheduleSweep();

  try {
    // Watching the file directly (not the dir) is enough for our case and
    // avoids reacting to other files in ~/.openclaw. If the file is replaced
    // atomically (rename-and-rename), the watcher will detect "rename" and
    // we'll re-trigger from the next change anyway — the boot sweep covers
    // the brief gap.
    state.watcher = watch(configPath, { persistent: false }, (eventType) => {
      // "change" — content modified; "rename" — file replaced (atomic write)
      if (eventType === "change" || eventType === "rename") {
        scheduleSweep();
      }
    });
    state.watcher.on("error", (err) => {
      console.warn("[openclaw-config-watcher] watch error:", err);
    });
    console.log(
      `[openclaw-config-watcher] watching ${configPath} (debounce ${DEBOUNCE_MS}ms)`,
    );
  } catch (err) {
    console.warn(
      `[openclaw-config-watcher] não consegui assistir ${configPath} — file watcher desabilitado. Cause:`,
      err,
    );
  }
}

export function getOpenClawConfigWatcherStats(): {
  started: boolean;
  sweepsRun: number;
  sweepsThatChanged: number;
} {
  return {
    started: state.started,
    sweepsRun: state.sweepsRun,
    sweepsThatChanged: state.sweepsThatChanged,
  };
}
