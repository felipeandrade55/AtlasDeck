/**
 * Recovery Status API
 * GET /api/recovery/status
 *
 * Returns a snapshot of OpenClaw + Linux health used by the Recovery panel.
 * Designed to keep working even when OpenClaw itself is down.
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OPENCLAW_DIR, OPENCLAW_CONFIG } from '@/lib/paths';

const execAsync = promisify(exec);

const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 4747);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${GATEWAY_PORT}`;

async function safeExec(cmd: string, timeoutMs = 4000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs, maxBuffer: 512 * 1024 });
    return { ok: true, out: (stdout || '').trim() || (stderr || '').trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, out: msg };
  }
}

async function checkBinary(bin: string): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  const which = await safeExec(`command -v ${bin}`, 2000);
  if (!which.ok || !which.out) return { installed: false, path: null, version: null };
  const bpath = which.out.split('\n')[0].trim();
  const ver = await safeExec(`${bin} --version`, 3000);
  return { installed: true, path: bpath, version: ver.ok ? ver.out.split('\n')[0] : null };
}

async function checkGatewayHttp(): Promise<{ reachable: boolean; status: number | null; latencyMs: number | null }> {
  const started = Date.now();
  const tryFetch = async (url: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      return res;
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const res = await tryFetch(`${GATEWAY_URL}/health`).catch(() => tryFetch(GATEWAY_URL));
    return { reachable: true, status: res.status, latencyMs: Date.now() - started };
  } catch {
    return { reachable: false, status: null, latencyMs: Date.now() - started };
  }
}

async function checkSystemdUnit(unit: string): Promise<{ exists: boolean; active: boolean; sub: string | null; since: string | null }> {
  const r = await safeExec(`systemctl show "${unit}" --no-page --property=LoadState,ActiveState,SubState,ActiveEnterTimestamp`, 3000);
  if (!r.ok) return { exists: false, active: false, sub: null, since: null };
  const props: Record<string, string> = {};
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const exists = (props.LoadState || 'not-found') !== 'not-found';
  return {
    exists,
    active: props.ActiveState === 'active',
    sub: props.SubState || null,
    since: props.ActiveEnterTimestamp || null,
  };
}

async function getDisk(): Promise<{ filesystem: string; size: string; used: string; avail: string; percent: number } | null> {
  const r = await safeExec(`df -h --output=source,size,used,avail,pcent / | tail -1`, 3000);
  if (!r.ok) return null;
  const parts = r.out.trim().split(/\s+/);
  if (parts.length < 5) return null;
  return {
    filesystem: parts[0],
    size: parts[1],
    used: parts[2],
    avail: parts[3],
    percent: Number((parts[4] || '0%').replace('%', '')) || 0,
  };
}

async function getLoad(): Promise<number[]> {
  try {
    return os.loadavg();
  } catch {
    return [0, 0, 0];
  }
}

function checkOpenclawDir(): { exists: boolean; configExists: boolean; dir: string; sizeHuman: string | null } {
  const exists = fs.existsSync(OPENCLAW_DIR);
  const configExists = fs.existsSync(OPENCLAW_CONFIG);
  return { exists, configExists, dir: OPENCLAW_DIR, sizeHuman: null };
}

async function getOpenclawProcs(): Promise<{ count: number; pids: number[] }> {
  const r = await safeExec(`pgrep -af openclaw || true`, 3000);
  if (!r.ok || !r.out) return { count: 0, pids: [] };
  const lines = r.out.split('\n').filter((l) => l.trim() && !l.includes('mission-control'));
  const pids: number[] = [];
  for (const l of lines) {
    const pid = Number(l.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid)) pids.push(pid);
  }
  return { count: pids.length, pids };
}

export async function GET() {
  const [
    openclawBin,
    claudeBin,
    codexBin,
    gatewayHttp,
    gatewayUnit,
    missionUnit,
    disk,
    procs,
  ] = await Promise.all([
    checkBinary('openclaw'),
    checkBinary('claude'),
    checkBinary('codex'),
    checkGatewayHttp(),
    checkSystemdUnit('openclaw-gateway'),
    checkSystemdUnit('mission-control'),
    getDisk(),
    getOpenclawProcs(),
  ]);

  const dirInfo = checkOpenclawDir();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const load = await getLoad();
  const cores = os.cpus().length || 1;

  const openclawHealthy = gatewayHttp.reachable && dirInfo.exists && dirInfo.configExists;
  const linuxHealthy =
    (disk?.percent ?? 0) < 90 &&
    memUsed / memTotal < 0.95 &&
    load[0] / cores < 4;

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    openclaw: {
      healthy: openclawHealthy,
      cli: openclawBin,
      directory: dirInfo,
      gateway: {
        ...gatewayHttp,
        port: GATEWAY_PORT,
        url: GATEWAY_URL,
        systemd: gatewayUnit,
      },
      processes: procs,
    },
    linux: {
      healthy: linuxHealthy,
      hostname: os.hostname(),
      platform: os.platform(),
      uptimeSec: Math.floor(os.uptime()),
      cpu: { cores, loadAvg: load },
      memory: {
        total: memTotal,
        free: memFree,
        used: memUsed,
        percent: Math.round((memUsed / memTotal) * 100),
      },
      disk,
      missionControl: missionUnit,
    },
    ai: {
      claude: claudeBin,
      codex: codexBin,
      anyAvailable: claudeBin.installed || codexBin.installed,
    },
  });
}
