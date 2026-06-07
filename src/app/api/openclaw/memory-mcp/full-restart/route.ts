/**
 * POST /api/openclaw/memory-mcp/full-restart
 *
 * Hard restart of the OpenClaw daemon (stop + sleep + start) instead
 * of the soft `restart` that triggers a hot-reload. The journalctl
 * showed `config hot reload applied (mcp)` after our soft restart —
 * meaning mcp.servers was loaded in RAM. But Codex threads already
 * established kept their original projection snapshot and never saw
 * the new server. Per the OpenClaw docs:
 *
 *   "thread app config (and likely MCP projection) is computed when
 *    OpenClaw establishes a Codex harness session… not recomputed
 *    on every turn"
 *
 * A hard stop+start forces every Codex thread to be recreated from
 * scratch on the next message — which IS when the new MCP projection
 * lands. This is the heavy hammer for the "tools listadas: não in
 * brand-new sessions" symptom.
 *
 * Tries systemctl --user first (per the user's VPS setup), falling
 * back to sudo systemctl and pm2. SIGKILL/respawn as last resort.
 */
import { NextResponse } from "next/server";
import { promisify } from "util";
import { exec } from "child_process";
import { waitForGateway } from "@/lib/openclaw-gateway-wait";
import { logActivity } from "@/lib/activities-db";

const execAsync = promisify(exec);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Attempt {
  cmd: string;
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function safeExec(cmd: string, timeoutMs: number): Promise<Attempt> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    return {
      cmd,
      ok: true,
      stdout: stdout.trim().slice(0, 2000),
      stderr: stderr.trim().slice(0, 2000),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      cmd,
      ok: false,
      stdout: (e.stdout ?? "").toString().trim().slice(0, 2000),
      stderr:
        (e.stderr ?? e.message ?? "").toString().trim().slice(0, 2000),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST() {
  const attempts: Attempt[] = [];
  let strategy: string | null = null;

  // ─── Strategy 1: systemctl --user stop + sleep + start ─────────
  const stopUser = await safeExec(
    "systemctl --user stop openclaw-gateway 2>&1",
    15_000,
  );
  attempts.push(stopUser);
  if (stopUser.ok) {
    await sleep(1500);
    const startUser = await safeExec(
      "systemctl --user start openclaw-gateway 2>&1",
      15_000,
    );
    attempts.push(startUser);
    if (startUser.ok) {
      strategy = "systemctl --user";
    }
  }

  // ─── Strategy 2: sudo systemctl ────────────────────────────────
  if (!strategy) {
    const stopSys = await safeExec(
      "sudo -n systemctl stop openclaw-gateway 2>&1",
      15_000,
    );
    attempts.push(stopSys);
    if (stopSys.ok) {
      await sleep(1500);
      const startSys = await safeExec(
        "sudo -n systemctl start openclaw-gateway 2>&1",
        15_000,
      );
      attempts.push(startSys);
      if (startSys.ok) {
        strategy = "sudo systemctl";
      }
    }
  }

  // ─── Strategy 3: pm2 delete + start (recreates the process) ──
  if (!strategy) {
    const ls = await safeExec("pm2 jlist 2>&1", 5000);
    attempts.push(ls);
    const hasPm2 = ls.ok && ls.stdout.includes("openclaw");
    if (hasPm2) {
      const stopPm2 = await safeExec(
        'pm2 stop openclaw-gateway 2>&1',
        15_000,
      );
      attempts.push(stopPm2);
      await sleep(1500);
      const startPm2 = await safeExec(
        'pm2 start openclaw-gateway 2>&1',
        15_000,
      );
      attempts.push(startPm2);
      if (startPm2.ok) {
        strategy = "pm2";
      }
    }
  }

  // ─── Wait for the gateway to listen again ──────────────────────
  const wait = strategy
    ? await waitForGateway({ timeoutMs: 20_000 })
    : { skipped: true as const };

  const ok =
    strategy !== null &&
    (("skipped" in wait) ? true : wait.ready);

  const summary = strategy
    ? `stop+start via ${strategy} · ${
        "skipped" in wait
          ? "wait pulado"
          : wait.ready
          ? `pronto em ${wait.elapsedMs}ms`
          : `não voltou em ${wait.elapsedMs}ms`
      }`
    : "nenhuma estratégia funcionou";

  logActivity(
    'command',
    `Full restart do gateway (memory MCP) ${ok ? 'concluído' : 'falhou'}`,
    ok ? 'success' : 'error',
    { metadata: { strategy, summary } }
  );

  return NextResponse.json({
    ok,
    strategy,
    attempts,
    wait,
    summary,
    hint: ok
      ? "Threads Codex foram destruídas. A próxima mensagem no Telegram cria thread nova que vai PEGAR o atlasdeck-memory."
      : "Falhou. Veja attempts pra entender qual estratégia bateu errado.",
  });
}
