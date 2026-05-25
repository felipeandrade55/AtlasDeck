/**
 * Reset OpenClaw — destructive nuke + reinstall trigger.
 *
 * Optional pre-reset backup (?backup=1) runs server-side so the entire
 * tear-down is a single SSE stream. After deletion we DO NOT auto-install
 * — the caller (ResetOpenClawPanel) navigates to /welcome on success so
 * the user can re-run the install wizard deliberately. The dashboard's
 * SetupGuard only *suggests* /welcome via a dismissible banner; it does
 * not force the navigation.
 *
 * What gets removed:
 *   - OpenClaw npm package (global + local-prefix fallback)
 *   - ~/.openclaw (workspaces, memory, openclaw.json)
 *   - ~/.openclaw-bin (the local-prefix install dir if it was used)
 *   - AtlasDeck-local pointers: data/openclaw-config.json,
 *     data/openclaw-fallback.json, data/provider-keys.json,
 *     data/telegram-accounts.json, data/agents-ui.json
 *   - memory_settings: setup_step → "install", setup_completed_at → null,
 *     llm_choice_made → false, welcome_notification_shown → false
 *
 * What stays:
 *   - data/memories.db (extracted memories survive)
 *   - data/chats.db, data/activities.db (history)
 *   - User's AtlasDeck login + .env
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { readOpenClawConfig, writeOpenClawConfig } from "@/lib/openclaw-config";
import { runBackup } from "@/lib/backup";
import { setSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

type Kind = "info" | "stdout" | "stderr" | "error";

function sseLine(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Sender {
  log: (kind: Kind, line: string) => void;
  done: (payload: Record<string, unknown>) => void;
  error: (message: string) => void;
}

async function runUninstall(send: Sender): Promise<void> {
  return new Promise((resolve) => {
    send.log("info", "$ npm uninstall -g openclaw");
    const child = spawn("npm", ["uninstall", "-g", "openclaw", "--no-fund", "--no-audit"], {
      env: process.env,
      windowsHide: true,
    });
    let carry = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      carry += chunk;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) if (line) send.log("stdout", line);
    });
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) if (line.trim()) send.log("stderr", line);
    });
    child.on("error", (err) => {
      send.log("stderr", `npm spawn falhou (ok, vamos seguir): ${err.message}`);
      resolve();
    });
    child.on("close", (code) => {
      if (carry) send.log("stdout", carry);
      send.log("info", `npm uninstall terminou com exit ${code}`);
      resolve();
    });
  });
}

function rmRecursive(target: string, send: Sender, label: string): void {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      send.log("info", `Removido: ${label} (${target})`);
    } else {
      send.log("info", `Pular ${label} — não existia (${target})`);
    }
  } catch (err) {
    send.log("stderr", `Aviso ao remover ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function performReset(send: Sender, withBackup: boolean): Promise<void> {
  // 1. Optional backup first — if it fails, abort so the user can
  // investigate (we don't want to delete data after a half-finished tarball)
  if (withBackup) {
    send.log("info", "Criando backup antes de remover…");
    try {
      const result = await runBackup();
      if (!result.success) {
        send.error(`Backup falhou: ${result.entry?.error ?? "erro desconhecido"}. Reinicialização abortada.`);
        return;
      }
      send.log("info", `Backup pronto: ${result.archivePath ?? result.entry?.id} (${result.entry?.sizeHuman ?? "?"})`);
    } catch (err) {
      send.error(`Backup lançou exceção: ${err instanceof Error ? err.message : String(err)}. Reinicialização abortada.`);
      return;
    }
  } else {
    send.log("info", "Backup pulado pelo usuário — prosseguindo direto pra remoção.");
  }

  // 2. Stop the daemon (best effort). systemctl/pm2 path: try both;
  // bare path: pkill the gateway PIDs. We don't fail the reset if any
  // of these complain — the binary is about to be deleted anyway.
  send.log("info", "Parando o gateway do OpenClaw (best-effort)…");
  await spawnSilent(send, "systemctl", ["stop", "openclaw-gateway"], "systemctl stop");
  await spawnSilent(send, "pm2", ["stop", "openclaw-gateway"], "pm2 stop");
  await spawnSilent(
    send,
    "pkill",
    ["-f", "openclaw[^ ]* gateway|openclaw-gateway"],
    "pkill gateway",
  );

  // 3. Uninstall the npm package (global). The local-prefix dir is removed
  // separately below — npm uninstall -g doesn't touch it.
  await runUninstall(send);

  // 4. Filesystem cleanup
  const cfg = readOpenClawConfig();
  const homeDir = os.homedir();
  const localPrefix = path.join(homeDir, ".openclaw-bin");
  rmRecursive(cfg.openclawDir, send, "diretório OpenClaw");
  rmRecursive(localPrefix, send, "prefixo local ~/.openclaw-bin");

  // 5. AtlasDeck-local pointers (rebuilt by the wizard on next install)
  const dataDir = path.join(process.cwd(), "data");
  for (const name of [
    "openclaw-config.json",
    "openclaw-fallback.json",
    "provider-keys.json",
    "telegram-accounts.json",
    "agents-ui.json",
  ]) {
    rmRecursive(path.join(dataDir, name), send, `data/${name}`);
  }

  // 6. Reset persisted setup flags — the next /api/setup/status call will
  // observe a clean slate and the dashboard SetupGuard kicks the wizard.
  try {
    setSettings({
      setup_step: "install",
      setup_completed_at: null,
      llm_choice_made: false,
      welcome_notification_shown: false,
    });
    send.log("info", "memory_settings: setup_step=install, completedAt=null, llm_choice_made=false");
  } catch (err) {
    send.log("stderr", `Falha ao resetar memory_settings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Re-seed an empty AtlasDeck-side config pointer so subsequent reads
  // don't fall back to stale env vars from a previous custom install
  try {
    writeOpenClawConfig({});
  } catch {
    // not critical — first install will write this anyway
  }

  try {
    logActivity("config", "OpenClaw reinicializado pelo usuário via wizard", "success", {
      metadata: { withBackup },
    });
  } catch {}

  send.done({ nextStep: "/welcome" });
}

function spawnSilent(send: Sender, cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env, windowsHide: true });
    let stderrTail = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-200);
    });
    child.on("error", () => {
      send.log("info", `${label}: comando não disponível (ok)`);
      resolve();
    });
    child.on("close", (code) => {
      const summary = code === 0 ? "ok" : `exit ${code}`;
      send.log("info", `${label}: ${summary}${stderrTail ? ` — ${stderrTail.trim()}` : ""}`);
      resolve();
    });
  });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const withBackup = url.searchParams.get("backup") === "1";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(sseLine(event, data)));
        } catch {
          // controller closed by client
        }
      };
      const sender: Sender = {
        log: (kind, line) => enqueue("log", { kind, line }),
        done: (payload) => enqueue("done", payload),
        error: (message) => enqueue("error", { message }),
      };

      try {
        await performReset(sender, withBackup);
      } catch (err) {
        sender.error(err instanceof Error ? err.message : String(err));
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
