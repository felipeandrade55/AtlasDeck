/**
 * GET /api/diagnose/gateway
 *
 * Self-service "what's wrong right now" endpoint that lets the user (or
 * us in a future session) diagnose Telegram/OpenClaw outages without
 * SSHing into the VPS. Designed so the user can pipe it to jq from any
 * machine that can reach the dashboard, e.g.:
 *
 *   curl -s http://localhost:3000/api/diagnose/gateway | jq
 *
 * Returns:
 *   - runtime:   how the gateway is supervised (systemd --user / system / pm2 / process)
 *   - pids:      PIDs and their uptime
 *   - dirty:     fields currently in openclaw.json that the schema would reject
 *                (we compute this by running the sweep in dry-run mode against
 *                a clone of the config — never mutating the file from here)
 *   - logs:      tail of the gateway's journalctl/log file
 *   - incidents: last N entries from data/incidents/, newest first
 *   - watchdog:  state of our auto-restart circuit breaker
 */
import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";
import path from "path";
import {
  detectGatewayRuntime,
  gatewayLogs,
} from "@/lib/gateway-control";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { migrateTelegramAccountsFromConfig } from "@/lib/telegram-accounts-local";
import { migrateWhatsappAccountsFromConfig } from "@/lib/whatsapp-accounts-local";
import { getLastHealth, getWatchdogState } from "@/lib/health-monitor";
import { getOpenClawConfigWatcherStats } from "@/lib/openclaw-config-watcher";

export const dynamic = "force-dynamic";

const INCIDENTS_DIR = path.join(process.cwd(), "data", "incidents");

interface DirtyReport {
  ran: boolean;
  cleanedTelegram: boolean;
  cleanedWhatsapp: boolean;
  error?: string;
  configPath: string;
}

/**
 * Dry-run sweep: clone the in-memory config and ask the migration helpers
 * if they would change anything. Same predicates the real sweep uses, but
 * never writes to disk. Lets the diagnose endpoint surface "your config
 * would be rejected by the gateway" without side effects.
 */
function dryRunSweep(): DirtyReport {
  const { path: configPath } = resolveOpenClawAgentsConfigPath();
  if (!existsSync(configPath)) {
    return { ran: false, cleanedTelegram: false, cleanedWhatsapp: false, configPath };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const clone = JSON.parse(JSON.stringify(raw));
    const cleanedTelegram = migrateTelegramAccountsFromConfig(clone);
    const cleanedWhatsapp = migrateWhatsappAccountsFromConfig(clone);
    return { ran: true, cleanedTelegram, cleanedWhatsapp, configPath };
  } catch (err) {
    return {
      ran: false,
      cleanedTelegram: false,
      cleanedWhatsapp: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readGatewayPidUptime(): Promise<Array<{ pid: number; startedAt: string; ageSeconds: number }>> {
  try {
    // Reuse the same procfs probe gateway-control already does, but inline
    // here so we don't expose findGatewayPids in the public API surface.
    const result: Array<{ pid: number; startedAt: string; ageSeconds: number }> = [];
    const entries = await readdir("/proc").catch(() => [] as string[]);
    for (const name of entries) {
      const pid = Number(name);
      if (!Number.isFinite(pid)) continue;
      let cmdline: string;
      try {
        cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replace(/\0/g, " ");
      } catch {
        continue;
      }
      const lc = cmdline.toLowerCase();
      if (!lc.includes("openclaw") || !lc.includes("gateway")) continue;
      // Skip ephemeral shells
      if (/^(?:[\w/.-]*\/)?(sh|bash|zsh|fish|dash|ksh)\s+-[ic]\s/.test(cmdline)) continue;
      try {
        const s = await stat(`/proc/${pid}`);
        const ms = Date.now() - s.ctimeMs;
        result.push({
          pid,
          startedAt: new Date(s.ctimeMs).toISOString(),
          ageSeconds: Math.floor(ms / 1000),
        });
      } catch {
        // Process disappeared between dir read and stat
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function readRecentIncidents(limit = 5): Promise<Array<{ file: string; modifiedAt: string; reason: string; preview: string }>> {
  try {
    const files = await readdir(INCIDENTS_DIR).catch(() => [] as string[]);
    const logs = files.filter((f) => f.endsWith(".log"));
    const withStats = await Promise.all(
      logs.map(async (f) => {
        const full = path.join(INCIDENTS_DIR, f);
        const s = await stat(full).catch(() => null);
        return s ? { file: f, mtime: s.mtimeMs, full } : null;
      }),
    );
    const sorted = withStats
      .filter((x): x is { file: string; mtime: number; full: string } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    return Promise.all(
      sorted.map(async (entry) => {
        let raw = "";
        try {
          raw = (await readFile(entry.full)).toString("utf8");
        } catch {
          // ignore
        }
        const reasonMatch = entry.file.match(/-(stuck-poller-[^-.]+|gateway-dead)/);
        return {
          file: entry.file,
          modifiedAt: new Date(entry.mtime).toISOString(),
          reason: reasonMatch?.[1] ?? "unknown",
          preview: raw.split("\n").slice(0, 8).join("\n"),
        };
      }),
    );
  } catch {
    return [];
  }
}

export async function GET() {
  const [runtime, pids, logs, incidents] = await Promise.all([
    detectGatewayRuntime(),
    readGatewayPidUptime(),
    gatewayLogs({ lines: 80, errorsOnly: false }).catch(() => null),
    readRecentIncidents(5),
  ]);

  const dirty = dryRunSweep();
  const lastHealth = getLastHealth();
  const watchdog = getWatchdogState();
  const watcher = getOpenClawConfigWatcherStats();

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    runtime,
    pids,
    config: {
      path: dirty.configPath,
      dirty: dirty.cleanedTelegram || dirty.cleanedWhatsapp,
      cleanedTelegram: dirty.cleanedTelegram,
      cleanedWhatsapp: dirty.cleanedWhatsapp,
      error: dirty.error,
      hint: (dirty.cleanedTelegram || dirty.cleanedWhatsapp)
        ? "openclaw.json contém campos que o schema rejeita. O próximo restart vai limpá-los automaticamente; pra limpar agora chame POST /api/openclaw/auto-fix ou reinicie pela UI."
        : "Schema-valid.",
    },
    logs: logs ? { source: logs.source, found: logs.found, output: logs.output } : null,
    incidents,
    health: lastHealth
      ? {
          summary: lastHealth.summary,
          ok: lastHealth.ok,
          checks: lastHealth.checks.map((c) => ({
            id: c.id,
            status: c.status,
            label: c.label,
            detail: c.detail,
          })),
          routing: lastHealth.routing,
        }
      : null,
    watchdog,
    watcher,
  });
}
