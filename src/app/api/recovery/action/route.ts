/**
 * Recovery Action API
 * POST /api/recovery/action
 * Body: { action: string }
 *
 * Executes a fixed catalog of recovery / diagnostic commands. The action name
 * is the *only* user-controlled input — no arbitrary strings are passed to the
 * shell. Use this instead of /api/terminal whenever possible.
 *
 * Some actions (gateway-restart, gateway-logs) use the gateway-control lib
 * to adapt across systemd / PM2 / bare-process installs, so the recovery
 * panel keeps working regardless of how the user launched OpenClaw.
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

import { gatewayLogs, restartGateway, startGateway, detectGatewayRuntime } from '@/lib/gateway-control';

const execAsync = promisify(exec);

type Severity = 'safe' | 'caution' | 'destructive';

interface ActionDef {
  description: string;
  severity: Severity;
  timeoutMs?: number;
  /** If true, the action restarts the dashboard itself and the response will be lost. */
  selfDisruptive?: boolean;
  /** Either a shell command OR a run() handler. Exactly one must be set. */
  cmd?: string;
  run?: () => Promise<{ output: string; success: boolean; error?: string }>;
}

const ACTIONS: Record<string, ActionDef> = {
  // ─── OpenClaw gateway (adaptive: systemd → PM2 → bare process) ──
  'gateway-restart': {
    description: 'Reinicia o gateway do OpenClaw (systemd, PM2 ou processo)',
    severity: 'caution',
    run: async () => {
      const r = await restartGateway();
      return {
        success: r.success,
        output: `[runtime: ${r.runtime}]\n${r.output}`,
        error: r.success ? undefined : 'Falha ao reiniciar o gateway — veja o log acima',
      };
    },
  },
  'gateway-start': {
    description: 'Inicia o gateway do OpenClaw quando ele está totalmente parado',
    severity: 'caution',
    run: async () => {
      const r = await startGateway();
      return {
        success: r.success,
        output: `[runtime: ${r.runtime}]\n${r.output}`,
        error: r.success ? undefined : 'Não consegui iniciar o gateway — veja o log acima',
      };
    },
  },
  'gateway-status': {
    description: 'Mostra como o gateway está rodando (systemd, PM2 ou processo)',
    severity: 'safe',
    run: async () => {
      const runtime = await detectGatewayRuntime();
      const lines: string[] = [`Runtime detectado: ${runtime}`];
      if (runtime === 'systemd') {
        const r = await execSafe('systemctl status openclaw-gateway --no-pager -l', 8000);
        lines.push(r.output);
      } else if (runtime === 'pm2') {
        const r = await execSafe('pm2 list 2>&1', 8000);
        lines.push(r.output);
      } else if (runtime === 'process') {
        const r = await execSafe('pgrep -af openclaw 2>/dev/null || true', 5000);
        lines.push(r.output || '(nenhum)');
      } else {
        lines.push('Nenhum gateway em execução. Sugestões:');
        lines.push('  - openclaw daemon start');
        lines.push('  - pm2 start openclaw-gateway');
        lines.push('  - systemctl start openclaw-gateway (se houver unit)');
      }
      return { success: true, output: lines.join('\n') };
    },
  },
  'gateway-diagnose': {
    description: 'Diagnóstico completo: TODOS processos OpenClaw + status + help + doctor',
    severity: 'safe',
    run: async () => {
      const sections: string[] = [];

      sections.push('═══ 1. Processos OpenClaw (pgrep) ═══');
      const r1 = await execSafe(`pgrep -af openclaw 2>/dev/null || echo '(nenhum match)'`, 5000);
      sections.push(r1.output);

      sections.push('\n═══ 2. ps -ef (filtrado) ═══');
      const r2 = await execSafe(
        `ps -eo pid,ppid,etime,cmd | grep -iE 'openclaw|node.*claw|/claw' | grep -v grep | head -20 || echo '(nenhum)'`,
        5000,
      );
      sections.push(r2.output);

      sections.push('\n═══ 3. openclaw --help (subcomandos disponíveis) ═══');
      const r3 = await execSafe(`timeout 5s openclaw --help 2>&1 | head -40 || echo '(falhou)'`, 8000);
      sections.push(r3.output);

      sections.push('\n═══ 4. openclaw status ═══');
      const r4 = await execSafe(`timeout 8s openclaw status 2>&1 || echo '(falhou ou não está rodando)'`, 10000);
      sections.push(r4.output);

      sections.push('\n═══ 5. Listening ports (gateway HTTP) ═══');
      const r5 = await execSafe(
        `ss -tlnp 2>/dev/null | grep -E ':(187[0-9][0-9]|808[0-9]|300[0-9])' | head -10 || netstat -tlnp 2>/dev/null | grep -E ':(187[0-9][0-9]|808[0-9]|300[0-9])' | head -10 || echo '(sem ss/netstat)'`,
        5000,
      );
      sections.push(r5.output);

      return { success: true, output: sections.join('\n') };
    },
  },
  'gateway-logs': {
    description: 'Últimas linhas de log do gateway (journalctl, PM2 ou arquivo)',
    severity: 'safe',
    run: async () => {
      const r = await gatewayLogs({ lines: 200 });
      return {
        success: r.found,
        output: `[fonte: ${r.source}]\n${r.output}`,
      };
    },
  },
  'gateway-logs-errors': {
    description: 'Últimos erros do gateway (journalctl, PM2 ou arquivo)',
    severity: 'safe',
    run: async () => {
      const r = await gatewayLogs({ lines: 200, errorsOnly: true });
      return {
        success: r.found,
        output: `[fonte: ${r.source}]\n${r.output}`,
      };
    },
  },

  // ─── OpenClaw CLI ────────────────────────────────────────────
  // `timeout` prefix avoids the CLI hanging for 15s+ when the daemon is down
  'openclaw-status': {
    cmd: 'timeout 8s openclaw status 2>&1',
    description: 'Status geral do OpenClaw',
    severity: 'safe',
    timeoutMs: 10_000,
  },
  'openclaw-doctor': {
    cmd: 'timeout 55s openclaw doctor 2>&1',
    description: 'Executa o diagnóstico completo do OpenClaw',
    severity: 'safe',
    timeoutMs: 60_000,
  },
  'openclaw-validate': {
    cmd: 'timeout 8s openclaw config validate 2>&1 || true',
    description: 'Valida o schema do openclaw.json e mostra erros exatos (não precisa do daemon)',
    severity: 'safe',
    timeoutMs: 10_000,
  },
  'openclaw-doctor-fix': {
    cmd: 'timeout 115s openclaw doctor --fix 2>&1',
    description: 'Diagnóstico + correção automática (openclaw doctor --fix)',
    severity: 'caution',
    timeoutMs: 120_000,
  },
  'openclaw-version': {
    cmd: 'timeout 5s openclaw --version 2>&1',
    description: 'Versão instalada do OpenClaw',
    severity: 'safe',
    timeoutMs: 8_000,
  },
  'openclaw-update': {
    cmd: 'openclaw update',
    description: 'Atualiza o OpenClaw para a última versão',
    severity: 'caution',
    timeoutMs: 180_000,
  },

  // ─── PM2 ─────────────────────────────────────────────────────
  'pm2-list': {
    cmd: 'pm2 list',
    description: 'Lista todos os processos do PM2',
    severity: 'safe',
  },
  'pm2-resurrect': {
    cmd: 'pm2 resurrect',
    description: 'Reanima processos PM2 salvos',
    severity: 'caution',
    timeoutMs: 30_000,
  },

  // ─── Diagnóstico Linux ───────────────────────────────────────
  'disk-usage': {
    cmd: 'df -h',
    description: 'Uso de disco',
    severity: 'safe',
  },
  'disk-top-dirs': {
    cmd: "du -h --max-depth=1 /var/log /tmp $HOME 2>/dev/null | sort -hr | head -20",
    description: 'Diretórios que mais consomem espaço',
    severity: 'safe',
    timeoutMs: 15_000,
  },
  'memory-status': {
    cmd: 'free -h',
    description: 'Memória RAM e swap',
    severity: 'safe',
  },
  'top-mem-processes': {
    cmd: 'ps aux --sort=-%mem | head -15',
    description: 'Top 15 processos por uso de RAM',
    severity: 'safe',
  },
  'top-cpu-processes': {
    cmd: 'ps aux --sort=-%cpu | head -15',
    description: 'Top 15 processos por uso de CPU',
    severity: 'safe',
  },
  'load-uptime': {
    cmd: 'uptime',
    description: 'Load average e uptime do sistema',
    severity: 'safe',
  },
  'network-listen': {
    cmd: "ss -tulpn 2>/dev/null | head -40 || netstat -tulpn 2>/dev/null | head -40",
    description: 'Portas abertas no servidor',
    severity: 'safe',
  },
  'system-journal-errors': {
    cmd: 'journalctl -p err -n 100 --no-pager',
    description: 'Últimos 100 erros do sistema (journalctl -p err)',
    severity: 'safe',
  },

  // ─── Limpeza ──────────────────────────────────────────────────
  'clear-tmp-old': {
    cmd: "find /tmp -type f -atime +7 -mtime +7 -delete 2>/dev/null; echo 'Limpeza /tmp concluída'",
    description: 'Apaga arquivos em /tmp não acessados há mais de 7 dias',
    severity: 'caution',
    timeoutMs: 30_000,
  },
  'clear-pm2-logs': {
    cmd: 'pm2 flush',
    description: 'Limpa os logs acumulados do PM2',
    severity: 'caution',
  },
  'clear-journal-old': {
    cmd: 'journalctl --vacuum-time=7d',
    description: 'Remove logs do systemd com mais de 7 dias',
    severity: 'caution',
    timeoutMs: 60_000,
  },

  // ─── Auto-restart do dashboard (use com cuidado) ─────────────
  'mission-control-restart': {
    cmd: 'systemctl restart mission-control 2>&1 || pm2 restart atlasdeck 2>&1 || pm2 restart mission-control 2>&1',
    description: 'Reinicia o próprio AtlasDeck (a página vai cair por alguns segundos)',
    severity: 'destructive',
    selfDisruptive: true,
  },
};

interface SafeExecResult {
  success: boolean;
  output: string;
  error?: string;
}

async function execSafe(cmd: string, timeoutMs: number): Promise<SafeExecResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      shell: '/bin/bash',
    });
    return {
      success: true,
      output: (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const killedByTimeout = err.killed && err.signal === 'SIGTERM';
    return {
      success: false,
      output: (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : ''),
      error: killedByTimeout
        ? `Comando excedeu o timeout de ${timeoutMs}ms`
        : err.message || String(e),
    };
  }
}

export function GET() {
  // Expose the catalog so the UI can render it dynamically
  const catalog = Object.entries(ACTIONS).map(([id, def]) => ({
    id,
    description: def.description,
    severity: def.severity,
    selfDisruptive: !!def.selfDisruptive,
  }));
  return NextResponse.json({ actions: catalog });
}

export async function POST(request: NextRequest) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 });
  }

  const id = (body.action || '').trim();
  if (!id) {
    return NextResponse.json({ error: 'Faltou o campo "action"' }, { status: 400 });
  }

  const def = ACTIONS[id];
  if (!def) {
    return NextResponse.json(
      {
        error: `Action "${id}" não está no catálogo`,
        hint: 'Chame GET /api/recovery/action para listar as actions válidas.',
      },
      { status: 400 },
    );
  }

  const started = Date.now();

  if (def.run) {
    try {
      const r = await def.run();
      return NextResponse.json({
        success: r.success,
        action: id,
        description: def.description,
        severity: def.severity,
        durationMs: Date.now() - started,
        output: r.output,
        error: r.error,
      });
    } catch (e) {
      return NextResponse.json({
        success: false,
        action: id,
        description: def.description,
        severity: def.severity,
        durationMs: Date.now() - started,
        output: '',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!def.cmd) {
    return NextResponse.json(
      { error: `Action "${id}" sem cmd nem run() — bug do catálogo` },
      { status: 500 },
    );
  }

  const r = await execSafe(def.cmd, def.timeoutMs ?? 15_000);
  return NextResponse.json({
    success: r.success,
    action: id,
    description: def.description,
    severity: def.severity,
    durationMs: Date.now() - started,
    output: r.output,
    error: r.error,
  });
}
