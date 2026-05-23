/**
 * Quick Actions API
 * POST /api/actions  body: { action }
 * Available actions: git-status, restart-gateway, clear-temp, usage-stats, heartbeat
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { readFile, readlink } from 'fs/promises';
import { logActivity } from '@/lib/activities-db';
import { OPENCLAW_WORKSPACE } from '@/lib/paths';

const execAsync = promisify(exec);

const WORKSPACE = OPENCLAW_WORKSPACE;

/**
 * Restart the OpenClaw gateway across the two setups we support:
 *
 *   1. systemd unit `openclaw-gateway.service` — covers the original
 *      AtlasDeck install playbook.
 *   2. Plain node process started by hand (e.g. `node
 *      /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789`)
 *      — covers the npm-global install where there is no service unit.
 *      For that case we discover the PID via `pgrep`, read the exact
 *      argv/cwd/env from /proc, send SIGTERM (then SIGKILL after 5s),
 *      and respawn the process detached so it survives this request.
 */
async function restartGateway(): Promise<string> {
  const logs: string[] = [];

  // Strategy 1: systemd
  try {
    const { stdout, stderr } = await execAsync('systemctl restart openclaw-gateway 2>&1');
    const { stdout: active } = await execAsync(
      'systemctl is-active openclaw-gateway 2>&1 || echo "unknown"',
    );
    if (active.trim() === 'active') {
      logs.push('✓ Reiniciado via systemd (openclaw-gateway.service)');
      logs.push(`Status: active`);
      return logs.join('\n');
    }
    logs.push(`systemd: indisponível (${(stdout || stderr).trim() || 'Unit not found'})`);
  } catch (err) {
    logs.push(`systemd: ${(err as Error).message.slice(0, 200)}`);
  }

  // Strategy 2: find the bare `openclaw ... gateway` process and respawn it
  let pid: number | null = null;
  try {
    const { stdout } = await execAsync(
      `pgrep -f 'openclaw.*gateway|openclaw/dist/index\\.js gateway'`,
    );
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (pids.length > 0) {
      // Skip our own PID just in case the regex matched the Next.js process
      pid = pids.find((p) => p !== process.pid) ?? null;
    }
  } catch {
    // pgrep exits 1 when nothing matches; treat as "not found"
  }

  if (!pid) {
    logs.push('✗ Nenhum processo openclaw gateway encontrado via pgrep');
    return logs.join('\n');
  }
  logs.push(`PID atual: ${pid}`);

  // Capture exact argv, cwd, env from /proc so the respawn is identical
  let argv: string[];
  let cwd: string;
  let env: Record<string, string> = {};
  try {
    const cmdlineRaw = await readFile(`/proc/${pid}/cmdline`);
    argv = cmdlineRaw.toString('utf8').split('\0').filter((s) => s.length > 0);
    if (argv.length === 0) throw new Error('cmdline vazio');
    cwd = await readlink(`/proc/${pid}/cwd`);
    try {
      const envRaw = await readFile(`/proc/${pid}/environ`);
      for (const pair of envRaw.toString('utf8').split('\0')) {
        const idx = pair.indexOf('=');
        if (idx > 0) env[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
    } catch {
      env = { ...process.env } as Record<string, string>;
    }
    logs.push(`argv: ${argv.slice(0, 6).join(' ')}${argv.length > 6 ? ' …' : ''}`);
    logs.push(`cwd: ${cwd}`);
  } catch (err) {
    logs.push(`✗ Não consegui ler /proc/${pid}: ${(err as Error).message}`);
    return logs.join('\n');
  }

  // SIGTERM, then SIGKILL after grace period
  try {
    process.kill(pid, 'SIGTERM');
    logs.push(`✓ SIGTERM → ${pid}`);
  } catch (err) {
    logs.push(`✗ SIGTERM falhou: ${(err as Error).message}`);
    return logs.join('\n');
  }

  const graceMs = 5000;
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      process.kill(pid, 0); // probe
    } catch {
      logs.push(`✓ Processo encerrou em ${Date.now() - start}ms`);
      break;
    }
  }
  try {
    process.kill(pid, 0);
    // still alive — force kill
    try {
      process.kill(pid, 'SIGKILL');
      logs.push('⚠ SIGKILL forçado após grace de 5s');
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // already dead
  }

  // Respawn detached with the original argv/cwd/env
  try {
    const [cmd, ...args] = argv;
    const child: ChildProcess = spawn(cmd, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    logs.push(`✓ Respawn detached PID ${child.pid}`);
  } catch (err) {
    logs.push(`✗ Respawn falhou: ${(err as Error).message}`);
    return logs.join('\n');
  }

  // Confirm it's alive
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const { stdout } = await execAsync(
      `pgrep -f 'openclaw.*gateway|openclaw/dist/index\\.js gateway'`,
    );
    const alive = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((p) => Number(p) !== process.pid);
    if (alive.length === 0) {
      logs.push('⚠ Verificação: nenhum gateway no pgrep após respawn');
    } else {
      logs.push(`✓ Verificação: gateway online (PID ${alive.join(', ')})`);
    }
  } catch {
    logs.push('⚠ pgrep não retornou na verificação');
  }

  return logs.join('\n');
}

interface ActionResult {
  action: string;
  status: 'success' | 'error';
  output: string;
  duration_ms: number;
  timestamp: string;
}

async function runAction(action: string): Promise<ActionResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  try {
    let output = '';

    switch (action) {
      case 'git-status': {
        // Find all git repos in workspace and get their status
        const { stdout: dirs } = await execAsync(`find "${WORKSPACE}" -maxdepth 2 -name ".git" -type d 2>/dev/null | head -10`);
        const repoPaths = dirs.trim().split('\n').filter(Boolean).map((d) => d.replace('/.git', ''));

        const results: string[] = [];
        for (const repoPath of repoPaths) {
          const name = repoPath.split('/').pop() || repoPath;
          try {
            const { stdout: status } = await execAsync(`cd "${repoPath}" && git status --short && git log --oneline -3 2>&1`);
            results.push(`📁 ${name}:\n${status || '(clean)'}`);
          } catch {
            results.push(`📁 ${name}: (error reading git status)`);
          }
        }
        output = results.length ? results.join('\n\n') : 'No git repos found in workspace';
        break;
      }

      case 'restart-gateway': {
        output = await restartGateway();
        break;
      }

      case 'clear-temp': {
        const commands = [
          'find /tmp -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null; echo "Cleaned /tmp"',
          `find "${WORKSPACE}" -name "*.tmp" -o -name "*.bak" | head -20 | xargs rm -f 2>/dev/null; echo "Cleaned tmp/bak files"`,
          'find /root/.pm2/logs -name "*.log" -size +50M -exec truncate -s 10M {} \\; 2>/dev/null; echo "Trimmed large PM2 logs"',
        ];
        const results = await Promise.all(commands.map((cmd) => execAsync(cmd).then((r) => r.stdout).catch((e) => e.message)));
        output = results.join('\n');
        break;
      }

      case 'usage-stats': {
        const { stdout: du } = await execAsync(`du -sh "${WORKSPACE}" 2>/dev/null || echo "N/A"`);
        const { stdout: df } = await execAsync('df -h / | tail -1');
        const { stdout: mem } = await execAsync('free -h | head -2');
        const { stdout: cpu } = await execAsync("top -bn1 | grep 'Cpu(s)' | head -1");
        const { stdout: uptime } = await execAsync('uptime -p');
        output = `Workspace: ${du.trim()}\n\nDisk: ${df.trim()}\n\nMemory:\n${mem.trim()}\n\nCPU: ${cpu.trim()}\n\nUptime: ${uptime.trim()}`;
        break;
      }

      case 'heartbeat': {
        // Check all critical services
        const systemdServices = ['openclaw-gateway'];
        const pm2services = ['atlasdeck'];
        const results: string[] = [];

        for (const svc of systemdServices) {
          const { stdout } = await execAsync(`systemctl is-active ${svc} 2>/dev/null || echo "inactive"`);
          const status = stdout.trim();
          results.push(`${status === 'active' ? '✅' : '❌'} ${svc}: ${status}`);
        }

        try {
          const { stdout: pm2 } = await execAsync('pm2 jlist 2>/dev/null');
          const pm2list = JSON.parse(pm2);
          for (const svc of pm2services) {
            const proc = pm2list.find((p: { name: string }) => p.name === svc);
            const status = proc?.pm2_env?.status || 'not found';
            results.push(`${status === 'online' ? '✅' : '❌'} ${svc} (pm2): ${status}`);
          }
        } catch {
          results.push('⚠️ PM2: could not connect');
        }

        // Ping the dashboard itself
        try {
          const { stdout: ping } = await execAsync('curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000');
          results.push(`\n🌐 localhost:3000: HTTP ${ping.trim()}`);
        } catch {
          results.push('\n🌐 localhost:3000: unreachable');
        }

        output = results.join('\n');
        break;
      }

      case 'npm-audit': {
        const { stdout, stderr } = await execAsync(`cd "${WORKSPACE}/mission-control" && npm audit --json 2>/dev/null | node -e "const d=require('fs').readFileSync('/dev/stdin','utf-8');const j=JSON.parse(d);console.log('Vulnerabilities: '+JSON.stringify(j.metadata?.vulnerabilities||{}))" 2>&1`).catch((e) => ({ stdout: '', stderr: e.message }));
        output = stdout || stderr || 'Audit completed';
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const duration_ms = Date.now() - start;
    logActivity('command', `Quick action: ${action}`, 'success', { duration_ms, metadata: { action } });

    return { action, status: 'success', output, duration_ms, timestamp };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    logActivity('command', `Quick action failed: ${action}`, 'error', { duration_ms, metadata: { action, error: errMsg } });
    return { action, status: 'error', output: errMsg, duration_ms, timestamp };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json({ error: 'Missing action' }, { status: 400 });
    }

    const validActions = ['git-status', 'restart-gateway', 'clear-temp', 'usage-stats', 'heartbeat', 'npm-audit'];
    if (!validActions.includes(action)) {
      return NextResponse.json({ error: `Unknown action. Valid: ${validActions.join(', ')}` }, { status: 400 });
    }

    const result = await runAction(action);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[actions] Error:', error);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
