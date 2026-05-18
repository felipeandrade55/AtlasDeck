/**
 * AI Recovery Assistant
 * POST /api/recovery/ai-fix
 * Body: {
 *   problem: string,           // user-described symptom
 *   cli?: 'claude' | 'codex' | 'auto',
 *   mode?: 'analyze' | 'fix',  // 'analyze' = read-only suggestions, 'fix' = let the AI run commands
 *   context?: string           // optional pre-collected diagnostic output
 * }
 *
 * Spawns the installed Claude Code or Codex CLI in headless mode with a
 * structured recovery prompt. Returns the AI's text response.
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 min hard cap

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`command -v ${bin}`, { timeout: 2000 });
    const p = stdout.trim().split('\n')[0];
    return p || null;
  } catch {
    return null;
  }
}

function buildPrompt(problem: string, mode: 'analyze' | 'fix', context: string): string {
  const isFix = mode === 'fix';
  return [
    `# AtlasDeck Recovery Assistant`,
    ``,
    `Você é um SRE/sysadmin sênior chamado pelo dashboard AtlasDeck (mission-control) para`,
    `${isFix ? 'INVESTIGAR E CORRIGIR' : 'INVESTIGAR E SUGERIR CORREÇÕES PARA'} um problema no servidor`,
    `Linux que hospeda o agente OpenClaw.`,
    ``,
    `## Problema reportado pelo operador`,
    problem || '(nenhuma descrição fornecida — faça um diagnóstico geral)',
    ``,
    `## Snapshot de diagnóstico já coletado`,
    '```',
    context || '(snapshot não fornecido)',
    '```',
    ``,
    `## Regras importantes`,
    `- Foco em restaurar o OpenClaw (gateway, CLI, workspace em ~/.openclaw) e a saúde do Linux.`,
    `- Serviços relevantes (systemd): \`openclaw-gateway\`, \`mission-control\`.`,
    `- Processos relevantes: \`openclaw\`, \`pm2\`.`,
    `- NUNCA execute: \`rm -rf /\`, \`mkfs\`, \`dd if=/dev/zero\`, formatação, shutdown/reboot, \`userdel\`, \`passwd\`.`,
    `- NUNCA exfiltre segredos (\`.env*\`, chaves SSH, tokens). Não use \`curl\`/\`wget\` para enviar dados externos.`,
    `- NÃO reinicie \`mission-control\` — isso derrubaria o próprio dashboard que te chamou.`,
    isFix
      ? `- Você pode executar comandos para inspecionar e corrigir. Prefira ações idempotentes e reversíveis.`
      : `- Modo análise: NÃO execute ações que alterem o sistema. Apenas inspecione e proponha comandos.`,
    `- Sempre explique em português o que você fez ou está sugerindo, em linguagem acessível.`,
    `- Ao final, retorne um resumo curto em formato:`,
    `  - **Diagnóstico:** ...`,
    `  - **Ações executadas:** ... (ou "nenhuma" no modo análise)`,
    `  - **Próximos passos para o humano:** ...`,
    ``,
    `Comece agora.`,
  ].join('\n');
}

interface CliInvocation {
  name: 'claude' | 'codex';
  bin: string;
  args: string[];
  /** If true, prompt is passed via stdin instead of argv. */
  promptViaStdin: boolean;
}

function buildClaudeInvocation(bin: string, mode: 'analyze' | 'fix'): CliInvocation {
  // Claude Code headless: `claude -p "<prompt>" --output-format text`
  // For "fix" mode the agent needs permissions to run shell tools.
  const args = ['-p', '--output-format', 'text'];
  if (mode === 'fix') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'plan');
  }
  return { name: 'claude', bin, args, promptViaStdin: true };
}

function buildCodexInvocation(bin: string, mode: 'analyze' | 'fix'): CliInvocation {
  // Codex CLI headless: `codex exec "<prompt>"` (auto-approves), `codex exec --read-only` for analyze.
  const args = ['exec'];
  if (mode === 'analyze') args.push('--sandbox', 'read-only');
  return { name: 'codex', bin, args, promptViaStdin: true };
}

async function pickCli(preference: 'claude' | 'codex' | 'auto', mode: 'analyze' | 'fix'): Promise<CliInvocation | null> {
  if (preference === 'claude') {
    const b = await which('claude');
    return b ? buildClaudeInvocation(b, mode) : null;
  }
  if (preference === 'codex') {
    const b = await which('codex');
    return b ? buildCodexInvocation(b, mode) : null;
  }
  // auto: prefer claude, fall back to codex
  const claudeBin = await which('claude');
  if (claudeBin) return buildClaudeInvocation(claudeBin, mode);
  const codexBin = await which('codex');
  if (codexBin) return buildCodexInvocation(codexBin, mode);
  return null;
}

function runCli(inv: CliInvocation, prompt: string): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(inv.bin, inv.args, {
      shell: false,
      env: { ...process.env, CI: '1', TERM: 'dumb' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, MAX_TIMEOUT_MS);
    t.unref();

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code, timedOut });
    });

    if (inv.promptViaStdin) {
      child.stdin?.write(prompt);
      child.stdin?.end();
    }
  });
}

export async function POST(request: NextRequest) {
  let body: { problem?: string; cli?: 'claude' | 'codex' | 'auto'; mode?: 'analyze' | 'fix'; context?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 });
  }

  const problem = (body.problem || '').slice(0, 4000);
  const context = (body.context || '').slice(0, 20_000);
  const cliPref = body.cli || 'auto';
  const mode: 'analyze' | 'fix' = body.mode === 'fix' ? 'fix' : 'analyze';

  const inv = await pickCli(cliPref, mode);
  if (!inv) {
    return NextResponse.json({
      success: false,
      error: 'Nenhum CLI de IA encontrado',
      hint: 'Instale Claude Code (`npm i -g @anthropic-ai/claude-code`) ou Codex CLI no servidor.',
    }, { status: 200 });
  }

  const prompt = buildPrompt(problem, mode, context);
  const started = Date.now();
  const result = await runCli(inv, prompt);
  const duration = Date.now() - started;

  return NextResponse.json({
    success: !result.timedOut && (result.code === 0 || (result.stdout && result.stdout.length > 0)),
    cli: inv.name,
    binary: inv.bin,
    mode,
    durationMs: duration,
    timedOut: result.timedOut,
    exitCode: result.code,
    output: result.stdout || '',
    stderr: result.stderr || '',
  });
}
