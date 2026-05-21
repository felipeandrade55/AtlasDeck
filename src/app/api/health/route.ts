/**
 * Health check endpoint
 * GET /api/health - Check health of all services and integrations
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getOpenClawGatewayInfo } from '@/lib/openclaw-config';

const execAsync = promisify(exec);

interface ServiceCheck {
  name: string;
  status: 'up' | 'down' | 'degraded' | 'unknown';
  latency?: number;
  details?: string;
  url?: string;
}

async function checkUrl(url: string, timeoutMs = 5000): Promise<{ status: 'up' | 'down'; latency: number; httpCode?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const latency = Date.now() - start;
    return { status: res.ok || res.status < 500 ? 'up' : 'down', latency, httpCode: res.status };
  } catch {
    return { status: 'down', latency: Date.now() - start };
  }
}

/**
 * HTTP reachability is the ground truth for the OpenClaw gateway — it may run
 * via systemd, PM2, manual `openclaw daemon`, Docker, etc. We probe the gateway
 * on the port advertised by `openclaw.json` and fall back to a systemd-unit
 * status check only as a secondary signal (and only to add detail, never to
 * downgrade an "up" verdict from HTTP).
 */
async function checkOpenClawGateway(): Promise<ServiceCheck> {
  const info = getOpenClawGatewayInfo();
  const candidates = Array.from(
    new Set([
      info.url,
      `${info.url.replace('127.0.0.1', 'localhost')}`,
      `http://127.0.0.1:${info.port}`,
    ])
  );

  const started = Date.now();
  for (const base of candidates) {
    const r = await checkUrl(`${base}/health`, 3000);
    if (r.status === 'up') {
      return {
        name: 'OpenClaw Gateway',
        status: 'up',
        latency: r.latency,
        url: `${base}/health`,
        details: `reachable (http ${r.httpCode ?? 200})`,
      };
    }
    // Some OpenClaw builds answer the gateway port without a /health route — a
    // 404 still means the daemon is up and listening. Anything except network
    // failure proves liveness.
    const root = await checkUrl(base, 3000);
    if (root.status === 'up') {
      return {
        name: 'OpenClaw Gateway',
        status: 'up',
        latency: root.latency,
        url: base,
        details: `reachable (http ${root.httpCode ?? 200})`,
      };
    }
  }

  // HTTP unreachable — annotate with systemd state if available (best-effort)
  let systemdDetail = '';
  try {
    const { stdout } = await execAsync('systemctl is-active openclaw-gateway 2>/dev/null');
    systemdDetail = stdout.trim();
  } catch {
    systemdDetail = 'not-managed-by-systemd';
  }
  return {
    name: 'OpenClaw Gateway',
    status: 'down',
    latency: Date.now() - started,
    url: info.url,
    details: `unreachable on port ${info.port}${systemdDetail ? ` (systemd: ${systemdDetail})` : ''}`,
  };
}

async function checkPm2Service(name: string): Promise<ServiceCheck> {
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    const list = JSON.parse(stdout);
    const proc = list.find((p: { name: string }) => p.name === name);
    if (!proc) return { name, status: 'unknown', details: 'not found in pm2' };
    const status = proc.pm2_env?.status === 'online' ? 'up' : 'down';
    return { name, status, details: `${proc.pm2_env?.status} · restarts: ${proc.pm2_env?.restart_time}` };
  } catch {
    return { name, status: 'unknown', details: 'pm2 not available' };
  }
}

export async function GET() {
  const checks: ServiceCheck[] = [];

  // Internal services
  const [atlasdeck, gateway] = await Promise.all([
    checkPm2Service('atlasdeck'),
    checkOpenClawGateway(),
  ]);
  checks.push({ ...atlasdeck, name: 'Mission Control' });
  checks.push(gateway);

  // External URLs
  const [anthropic] = await Promise.all([
    checkUrl('https://api.anthropic.com', 3000),
  ]);

  checks.push({
    name: 'Anthropic API',
    status: anthropic.status === 'up' || (anthropic as { httpCode?: number }).httpCode === 401 ? 'up' : anthropic.status,
    latency: anthropic.latency,
    url: 'https://api.anthropic.com',
    details: anthropic.status === 'up' || (anthropic as { httpCode?: number }).httpCode === 401 ? 'reachable' : 'unreachable',
  });

  // Overall status
  const downCount = checks.filter((c) => c.status === 'down').length;
  const overallStatus = downCount === 0 ? 'healthy' : downCount < checks.length / 2 ? 'degraded' : 'critical';

  return NextResponse.json({
    status: overallStatus,
    checks,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}
