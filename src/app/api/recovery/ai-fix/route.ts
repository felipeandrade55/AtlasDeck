/**
 * AI Recovery Assistant — streaming SSE
 * POST /api/recovery/ai-fix
 *
 * Body: {
 *   problem: string,                    // user-described symptom
 *   cli?: 'claude' | 'codex' | 'auto',
 *   mode?: 'analyze' | 'fix',           // user-selected mode
 *   phase?: 'analyze' | 'execute',      // workflow phase (default: 'analyze')
 *   context?: string,                   // pre-collected diagnostic snapshot
 *   plan?: string,                      // for phase=execute: the approved plan markdown
 * }
 *
 * Returns: text/event-stream with events:
 *   { event:'meta',   cli, mode, phase, command }
 *   { event:'chunk',  source:'stdout'|'stderr', text }
 *   { event:'error',  kind, message, hint? }
 *   { event:'done',   exitCode, durationMs, timedOut, hasDestructive? }
 */
import { NextRequest } from 'next/server';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_MODEL = process.env.ATLASDECK_CODEX_MODEL || 'gpt-5.5-codex';
const CODEX_EFFORT = process.env.ATLASDECK_CODEX_EFFORT || 'medium';

// Commands we never let the AI run, regardless of mode.
const HARD_BLOCK_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+if=\/dev\/(zero|random|urandom)\s+of=\/dev\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\buserdel\b/,
  /\bpasswd\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}/, // fork bomb
];

// Patterns that look destructive but may be legitimate — UI asks user.
const DESTRUCTIVE_HINTS: RegExp[] = [
  /\brm\s+-rf?\b/,
  /\bsystemctl\s+(stop|disable|mask)\s+mission-control\b/,
  /\bdrop\s+(database|table)\b/i,
  /\btruncate\b/i,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  /\bjournalctl\s+--vacuum/,
  /\bdocker\s+(system\s+)?prune/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`command -v ${bin}`, { timeout: 2000 });
    const p = stdout.trim().split('\n')[0];
    return p || null;
  } catch {
    return null;
  }
}

function commonRules(): string[] {
  return [
    `## Regras de segurança (NUNCA viole)`,
    `- NUNCA execute: \`rm -rf /\`, \`mkfs\`, \`dd if=/dev/zero of=/dev/...\`, \`shutdown\`, \`reboot\`, \`userdel\`, \`passwd\`.`,
    `- NUNCA exfiltre segredos (\`.env*\`, chaves SSH, tokens). Não use \`curl\`/\`wget\` para enviar dados externos.`,
    `- NÃO reinicie \`mission-control\` — isso derruba o próprio dashboard que te chamou.`,
    `- Serviços relevantes (systemd): \`openclaw-gateway\`. Processos: \`openclaw\`, \`pm2\`.`,
    `- Workspace do OpenClaw: \`~/.openclaw\`.`,
  ];
}

function buildAnalyzePrompt(problem: string, context: string): string {
  return [
    `# AtlasDeck Recovery — Fase 1: ANALISAR`,
    ``,
    `Você é um SRE sênior chamado pelo dashboard AtlasDeck para diagnosticar um problema no servidor Linux que hospeda o agente OpenClaw.`,
    `Nesta fase você **NÃO executa nada que altere o sistema**. Apenas inspeciona (somente leitura) e propõe um plano.`,
    ``,
    `## Problema relatado pelo operador`,
    problem || '(nenhuma descrição — faça um diagnóstico geral de saúde)',
    ``,
    `## Snapshot já coletado pelo dashboard`,
    '```',
    context || '(sem snapshot)',
    '```',
    ``,
    ...commonRules(),
    ``,
    `## Formato de saída OBRIGATÓRIO (markdown, em português, exatamente estas seções)`,
    ``,
    `## Diagnóstico`,
    `<1–3 frases curtas: o que está acontecendo>`,
    ``,
    `## Causa provável`,
    `<1–3 frases: por que está acontecendo>`,
    ``,
    `## Plano de correção`,
    `<lista numerada de comandos shell. Para CADA item use a marcação:>`,
    `1. \`<comando>\` — [SAFE|CAUTION|DESTRUCTIVE] <descrição curta>`,
    `2. \`<comando>\` — [SAFE|CAUTION|DESTRUCTIVE] <descrição curta>`,
    `<...etc. Use SAFE para leitura/status, CAUTION para restart/reload, DESTRUCTIVE para apagar dados, kill -9, prune, drop, rm -rf.>`,
    ``,
    `## Resumo`,
    `<1 frase: o que esse plano faz>`,
    ``,
    `**Importante:** apenas proponha. Não execute comandos que alterem o sistema. Pode rodar comandos de leitura (cat, ls, systemctl status, journalctl) para confirmar suas hipóteses.`,
  ].join('\n');
}

function buildExecutePrompt(problem: string, context: string, plan: string): string {
  return [
    `# AtlasDeck Recovery — Fase 2: EXECUTAR`,
    ``,
    `O operador aprovou o plano abaixo. Execute-o passo a passo agora.`,
    ``,
    `## Problema original`,
    problem || '(sem descrição)',
    ``,
    `## Plano aprovado`,
    plan,
    ``,
    `## Snapshot inicial`,
    '```',
    context || '(sem snapshot)',
    '```',
    ``,
    ...commonRules(),
    ``,
    `## Como executar`,
    `- Execute cada passo na ordem. Para cada comando, anuncie: \`▶ Passo N: <comando>\`.`,
    `- Após cada comando, mostre o resultado resumido (ok/falhou + 1 linha).`,
    `- Se um passo falhar e for crítico, **PARE** e reporte. Não invente comandos novos fora do plano sem necessidade.`,
    `- Se durante a execução perceber que precisa de algo destrutivo NÃO listado no plano original, **PARE** e peça nova aprovação no resumo final.`,
    ``,
    `## Formato de saída final (depois de executar)`,
    ``,
    `## Resultado`,
    `<status geral: tudo ok | parcial | falhou>`,
    ``,
    `## Passos executados`,
    `<lista numerada com ✓ / ✗ por passo>`,
    ``,
    `## Estado atual`,
    `<o que ficou melhor / o que continua falhando>`,
    ``,
    `## Próximos passos para o humano`,
    `<o que o operador deve fazer ou monitorar agora>`,
  ].join('\n');
}

interface CliInvocation {
  name: 'claude' | 'codex';
  bin: string;
  args: string[];
  displayCmd: string;
}

function buildClaudeInvocation(bin: string, phase: 'analyze' | 'execute'): CliInvocation {
  const args = ['-p', '--output-format', 'text'];
  if (phase === 'execute') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'plan');
  }
  return { name: 'claude', bin, args, displayCmd: `claude ${args.join(' ')}` };
}

function buildCodexInvocation(bin: string, phase: 'analyze' | 'execute'): CliInvocation {
  const args = [
    'exec',
    '-c', `model=${CODEX_MODEL}`,
    '-c', `model_reasoning_effort=${CODEX_EFFORT}`,
  ];
  if (phase === 'analyze') {
    args.push('--sandbox', 'read-only');
  } else {
    args.push('--sandbox', 'danger-full-access');
  }
  return { name: 'codex', bin, args, displayCmd: `codex ${args.join(' ')}` };
}

async function pickCli(
  preference: 'claude' | 'codex' | 'auto',
  phase: 'analyze' | 'execute',
): Promise<CliInvocation | null> {
  if (preference === 'claude') {
    const b = await which('claude');
    return b ? buildClaudeInvocation(b, phase) : null;
  }
  if (preference === 'codex') {
    const b = await which('codex');
    return b ? buildCodexInvocation(b, phase) : null;
  }
  const claudeBin = await which('claude');
  if (claudeBin) return buildClaudeInvocation(claudeBin, phase);
  const codexBin = await which('codex');
  if (codexBin) return buildCodexInvocation(codexBin, phase);
  return null;
}

function classifyError(stderr: string, stdout: string): { kind: string; message: string; hint: string } | null {
  const blob = `${stderr}\n${stdout}`.toLowerCase();

  if (blob.includes('not supported when using codex with a chatgpt account') || /'gpt-[\d.\-a-z]+' model is not supported/i.test(blob)) {
    const m = blob.match(/'([^']+)' model is not supported/);
    return {
      kind: 'model_not_supported',
      message: `O modelo "${m?.[1] ?? 'configurado'}" não é compatível com a conta ChatGPT do servidor.`,
      hint: `Defina a env var ATLASDECK_CODEX_MODEL=gpt-5.5-codex (ou outro suportado) no servidor e reinicie o AtlasDeck. Default atual: ${CODEX_MODEL}.`,
    };
  }
  if (blob.includes('not authenticated') || blob.includes('please run `codex login`') || blob.includes('please run `claude login`')) {
    return {
      kind: 'not_authenticated',
      message: 'CLI de IA não está autenticado no servidor.',
      hint: 'Rode `codex login` ou `claude login` no servidor como o usuário que executa o AtlasDeck.',
    };
  }
  if (blob.includes('could not find bubblewrap') && blob.includes('error')) {
    // bubblewrap warning é só aviso; só sinaliza se vier junto com falha real
  }
  if (blob.includes('rate limit') || blob.includes('quota exceeded')) {
    return {
      kind: 'rate_limit',
      message: 'A API atingiu o limite de uso.',
      hint: 'Aguarde alguns minutos ou troque para outro CLI (Claude/Codex) no seletor.',
    };
  }
  if (blob.includes('command not found') || blob.includes('enoent')) {
    return {
      kind: 'cli_missing',
      message: 'Binário do CLI não encontrado no PATH.',
      hint: 'Instale `claude` (npm i -g @anthropic-ai/claude-code) ou `codex` no servidor.',
    };
  }
  return null;
}

function detectDestructive(plan: string): string[] {
  const matches: string[] = [];
  for (const line of plan.split('\n')) {
    if (HARD_BLOCK_PATTERNS.some((re) => re.test(line))) {
      matches.push(`BLOCKED: ${line.trim()}`);
      continue;
    }
    if (/\[DESTRUCTIVE\]/i.test(line)) {
      matches.push(line.trim());
      continue;
    }
    if (DESTRUCTIVE_HINTS.some((re) => re.test(line))) {
      matches.push(line.trim());
    }
  }
  return matches;
}

function containsHardBlock(plan: string): string | null {
  for (const line of plan.split('\n')) {
    for (const re of HARD_BLOCK_PATTERNS) {
      if (re.test(line)) return line.trim();
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: {
    problem?: string;
    cli?: 'claude' | 'codex' | 'auto';
    mode?: 'analyze' | 'fix';
    phase?: 'analyze' | 'execute';
    context?: string;
    plan?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Body JSON inválido' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  const problem = (body.problem || '').slice(0, 4000);
  const context = (body.context || '').slice(0, 20_000);
  const cliPref = body.cli || 'auto';
  const phase: 'analyze' | 'execute' = body.phase === 'execute' ? 'execute' : 'analyze';
  const plan = (body.plan || '').slice(0, 12_000);

  // Hard-block check: if user is trying to execute a plan with a forbidden command, refuse.
  if (phase === 'execute') {
    const blocked = containsHardBlock(plan);
    if (blocked) {
      return new Response(
        JSON.stringify({
          event: 'error',
          kind: 'hard_blocked',
          message: 'O plano contém um comando explicitamente proibido. Execução abortada.',
          line: blocked,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  const inv = await pickCli(cliPref, phase);
  if (!inv) {
    return new Response(
      JSON.stringify({
        event: 'error',
        kind: 'cli_missing',
        message: 'Nenhum CLI de IA encontrado no servidor.',
        hint: 'Instale Claude Code (`npm i -g @anthropic-ai/claude-code`) ou Codex CLI.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const prompt = phase === 'execute'
    ? buildExecutePrompt(problem, context, plan)
    : buildAnalyzePrompt(problem, context);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller closed
        }
      };

      send({ event: 'meta', cli: inv.name, phase, command: inv.displayCmd });

      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(inv.bin, inv.args, {
        shell: false,
        env: { ...process.env, CI: '1', TERM: 'dumb' },
      });

      const finishOnce = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - started;
        const err = classifyError(stderr, stdout);
        if (err) {
          send({ event: 'error', kind: err.kind, message: err.message, hint: err.hint });
        }
        const fullText = stdout + (stderr ? `\n\n[stderr]\n${stderr}` : '');
        const destructive = phase === 'analyze' ? detectDestructive(fullText) : [];
        send({
          event: 'done',
          exitCode,
          durationMs,
          timedOut,
          rawOutput: stdout,
          rawStderr: stderr,
          destructive,
          hasDestructive: destructive.length > 0,
        });
        try { controller.close(); } catch {}
      };

      const timer = setTimeout(() => {
        timedOut = true;
        send({ event: 'chunk', source: 'stderr', text: '\n[timeout 5min — encerrando processo]\n' });
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
      }, MAX_TIMEOUT_MS);
      timer.unref();

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        send({ event: 'chunk', source: 'stdout', text });
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        send({ event: 'chunk', source: 'stderr', text });
      });
      child.on('error', (e) => {
        stderr += `\n[spawn error] ${e.message}`;
        send({ event: 'chunk', source: 'stderr', text: `\n[spawn error] ${e.message}\n` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finishOnce(code);
      });

      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (e) {
        send({ event: 'chunk', source: 'stderr', text: `\n[stdin error] ${(e as Error).message}\n` });
      }

      // Abort if client disconnects
      request.signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
