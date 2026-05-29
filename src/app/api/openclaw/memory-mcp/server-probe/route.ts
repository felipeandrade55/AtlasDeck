/**
 * GET /api/openclaw/memory-mcp/server-probe
 *
 * Last-mile diagnostic when everything in mcp.servers looks correct
 * but tools still don't reach the LLM. Tries to surface what's
 * happening on the OpenClaw side WITHOUT requiring SSH from the user:
 *
 *   1) Runs `openclaw mcp show atlasdeck-memory --json` and
 *      `openclaw mcp list --json` if the CLI is available — these
 *      are the authoritative views of what the daemon thinks of
 *      the registration.
 *
 *   2) Tails gateway logs, filtering for lines that mention "mcp",
 *      "atlasdeck-memory", "projection", or known error patterns.
 *      Looks in the canonical log locations from the docs:
 *        - /tmp/openclaw/openclaw-YYYY-MM-DD.log
 *        - ~/.openclaw/logs/gateway.log
 *
 * Returns null/empty fields when something isn't available — the UI
 * shows whichever sections came back populated.
 */
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import os from "os";
import { NextResponse } from "next/server";
import { getOpenClawDir, getOpenClawBin } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface CliCall {
  cmd: string;
  args: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function tryCli(args: string[]): Promise<CliCall> {
  const bin = getOpenClawBin();
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, OPENCLAW_DIR: getOpenClawDir() },
    });
    return {
      cmd: bin,
      args,
      ok: true,
      stdout: stdout.trim().slice(0, 8000),
      stderr: stderr.trim().slice(0, 2000),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      cmd: bin,
      args,
      ok: false,
      stdout: (e.stdout ?? "").toString().trim().slice(0, 4000),
      stderr: (e.stderr ?? e.message ?? "").toString().trim().slice(0, 4000),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Walk a few known log locations, return the most recent file's tail.
 * MCP-related grep happens on the client (just sending the raw tail
 * keeps the endpoint simple and the filter visible to the user).
 */
async function readJournalctl(): Promise<{
  available: boolean;
  lines: string[];
  mcpLines: string[];
}> {
  // OpenClaw VPS runs via `systemctl --user` (per the user's memory).
  // Logs go to the systemd journal — `/tmp/openclaw/*.log` is empty
  // because the daemon doesn't write a file there in that setup.
  // journalctl is the source of truth.
  const candidates = [
    ["--user-unit", "openclaw-gateway.service", "-n", "400", "--no-pager", "-o", "short-iso"],
    ["--user-unit", "openclaw.service", "-n", "400", "--no-pager", "-o", "short-iso"],
    ["--user", "-n", "400", "--no-pager", "-o", "short-iso"],
  ];
  for (const args of candidates) {
    try {
      const { stdout } = await execFileAsync("journalctl", args, {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const lines = stdout.split("\n").slice(-400);
      const mcpLines = lines.filter((l) =>
        /\b(mcp|atlasdeck-memory|MCP|projection|tool list|tools loaded|server load|approval|spawn)\b/i.test(
          l,
        ),
      );
      if (mcpLines.length > 0 || lines.some((l) => l.includes("openclaw"))) {
        return { available: true, lines, mcpLines: mcpLines.slice(-80) };
      }
    } catch {}
  }
  return { available: false, lines: [], mcpLines: [] };
}

async function getGatewayProcessInfo(): Promise<{
  pid: number | null;
  uptimeSeconds: number | null;
  cmdline: string | null;
  detectedVia: string | null;
}> {
  // Try pgrep first — fastest, no parsing
  for (const pattern of ["openclaw-gateway", "openclaw.*gateway", "openclaw daemon", "openclaw"]) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern], {
        timeout: 2000,
      });
      const pid = parseInt(stdout.trim().split("\n")[0], 10);
      if (!Number.isFinite(pid)) continue;
      // Read /proc for uptime + cmdline
      let uptimeSeconds: number | null = null;
      let cmdline: string | null = null;
      try {
        const stat = fs.statSync(`/proc/${pid}`);
        uptimeSeconds = Math.floor((Date.now() - stat.ctimeMs) / 1000);
      } catch {}
      try {
        cmdline = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
          .replace(/\0/g, " ")
          .trim()
          .slice(0, 200);
      } catch {}
      return { pid, uptimeSeconds, cmdline, detectedVia: `pgrep -f ${pattern}` };
    } catch {}
  }
  return { pid: null, uptimeSeconds: null, cmdline: null, detectedVia: null };
}

async function tailGatewayLogs(): Promise<{
  path: string | null;
  exists: boolean;
  lines: string[];
  mcpLines: string[];
  journalctl: {
    available: boolean;
    lines: string[];
    mcpLines: string[];
  };
}> {
  const candidates: string[] = [];
  // Today's canonical log
  const today = new Date().toISOString().slice(0, 10);
  candidates.push(`/tmp/openclaw/openclaw-${today}.log`);
  // Yesterday — if gateway was started yesterday and never rotated
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  candidates.push(`/tmp/openclaw/openclaw-${yesterday}.log`);
  candidates.push(path.join(getOpenClawDir(), "logs", "gateway.log"));
  candidates.push(path.join(os.homedir(), ".openclaw", "logs", "gateway.log"));

  let logPath: string | null = null;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        logPath = c;
        break;
      }
    } catch {}
  }
  // Always also try journalctl — primary log path for systemctl-user setups.
  const journalctl = await readJournalctl();
  if (!logPath) {
    return {
      path: null,
      exists: false,
      lines: [],
      mcpLines: [],
      journalctl,
    };
  }
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - 200_000); // tail ~200KB
    const buf = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf-8");
    const lines = text.split("\n").slice(-400);
    const mcpLines = lines.filter((l) =>
      /\b(mcp|atlasdeck-memory|MCP|projection|tool list|tools loaded|server load|approval)\b/i.test(
        l,
      ),
    );
    return {
      path: logPath,
      exists: true,
      lines,
      mcpLines: mcpLines.slice(-80),
      journalctl,
    };
  } catch (err) {
    return {
      path: logPath,
      exists: true,
      lines: [`(falha ao ler: ${err instanceof Error ? err.message : err})`],
      mcpLines: [],
      journalctl,
    };
  }
}

export async function GET() {
  const [show, list, logs, proc] = await Promise.all([
    tryCli(["mcp", "show", "atlasdeck-memory", "--json"]),
    tryCli(["mcp", "list", "--json"]),
    tailGatewayLogs(),
    getGatewayProcessInfo(),
  ]);
  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      cli: { show, list },
      process: proc,
      gatewayLog: {
        path: logs.path,
        exists: logs.exists,
        mcpLineCount: logs.mcpLines.length,
        mcpLines: logs.mcpLines,
        journalctl: logs.journalctl,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
