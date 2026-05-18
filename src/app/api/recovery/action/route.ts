/**
 * Recovery Action API
 * POST /api/recovery/action
 * Body: { action: string }
 *
 * Executes a fixed catalog of recovery / diagnostic commands. The action name
 * is the *only* user-controlled input — no arbitrary strings are passed to the
 * shell. Use this instead of /api/terminal whenever possible.
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type Severity = 'safe' | 'caution' | 'destructive';

interface ActionDef {
  cmd: string;
  description: string;
  severity: Severity;
  timeoutMs?: number;
  /** If true, the action restarts the dashboard itself and the response will be lost. */
  selfDisruptive?: boolean;
}

const ACTIONS: Record<string, ActionDef> = {
  // ─── OpenClaw gateway via systemd ────────────────────────────
  'gateway-status': {
    cmd: 'systemctl status openclaw-gateway --no-pager -l',
    description: 'Mostra o status do serviço openclaw-gateway',
    severity: 'safe',
  },
  'gateway-restart': {
    cmd: 'systemctl restart openclaw-gateway',
    description: 'Reinicia o gateway do OpenClaw',
    severity: 'caution',
  },
  'gateway-start': {
    cmd: 'systemctl start openclaw-gateway',
    description: 'Inicia o gateway do OpenClaw',
    severity: 'caution',
  },
  'gateway-stop': {
    cmd: 'systemctl stop openclaw-gateway',
    description: 'Para o gateway do OpenClaw',
    severity: 'destructive',
  },
  'gateway-logs': {
    cmd: 'journalctl -u openclaw-gateway -n 200 --no-pager',
    description: 'Últimas 200 linhas de log do gateway',
    severity: 'safe',
  },
  'gateway-logs-errors': {
    cmd: 'journalctl -u openclaw-gateway -n 200 --no-pager -p err',
    description: 'Últimos erros do gateway',
    severity: 'safe',
  },

  // ─── OpenClaw CLI ────────────────────────────────────────────
  'openclaw-status': {
    cmd: 'openclaw status',
    description: 'Status geral do OpenClaw',
    severity: 'safe',
  },
  'openclaw-doctor': {
    cmd: 'openclaw doctor',
    description: 'Executa o diagnóstico completo do OpenClaw',
    severity: 'safe',
    timeoutMs: 60_000,
  },
  'openclaw-version': {
    cmd: 'openclaw --version',
    description: 'Versão instalada do OpenClaw',
    severity: 'safe',
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
    cmd: 'systemctl restart mission-control',
    description: 'Reinicia o próprio AtlasDeck (a página vai cair por alguns segundos)',
    severity: 'destructive',
    selfDisruptive: true,
  },
};

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
    return NextResponse.json({
      error: `Action "${id}" não está no catálogo`,
      hint: 'Chame GET /api/recovery/action para listar as actions válidas.',
    }, { status: 400 });
  }

  const timeout = def.timeoutMs ?? 15_000;
  const started = Date.now();

  try {
    const { stdout, stderr } = await execAsync(def.cmd, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      shell: '/bin/bash',
    });
    const duration = Date.now() - started;
    return NextResponse.json({
      success: true,
      action: id,
      description: def.description,
      severity: def.severity,
      durationMs: duration,
      output: (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    const duration = Date.now() - started;
    const killedByTimeout = err.killed && err.signal === 'SIGTERM';
    return NextResponse.json({
      success: false,
      action: id,
      description: def.description,
      severity: def.severity,
      durationMs: duration,
      output: (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : ''),
      error: killedByTimeout
        ? `Comando excedeu o timeout de ${timeout}ms`
        : err.message || String(e),
    }, { status: 200 }); // 200 with success:false so the UI can render the output
  }
}
