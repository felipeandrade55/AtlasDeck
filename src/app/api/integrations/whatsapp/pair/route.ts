import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import { readOpenClawConfig, resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { migrateWhatsappAccountsFromConfig } from "@/lib/whatsapp-accounts-local";
import {
  WHATSAPP_PLUGIN,
  isPluginInstalled,
  installPluginStreaming,
  buildOpenClawEnvPath,
} from "@/lib/openclaw-plugins";
import fs from "fs";

export const dynamic = "force-dynamic";

interface PairState {
  child: ChildProcess;
  output: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

// Global active pairs map, surviving Next.js fast-refresh during dev
const globalKey = "activeWhatsappPairs" as const;
const globalAny = globalThis as unknown as Record<string, Map<string, PairState> | undefined>;
const activePairs: Map<string, PairState> = globalAny[globalKey] ?? new Map<string, PairState>();
globalAny[globalKey] = activePairs;

function stripAnsi(str: string): string {
  return str
    // ANSI escape sequences (colors, cursor moves, clear screen, etc.).
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    // PTY (`script -qfc`) emits \r\n line endings — normalize so the <pre>
    // doesn't double-space, which would push the QR off-screen.
    .replace(/\r\n/g, "\n")
    // Standalone \r (line-overwrite, used by progress bars). Keep only the
    // text after the last \r within a line so the final state shows.
    .replace(/^.*\r(?!\n)/gm, "");
}

// ─── GET (poll current pairing state) ────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const accountId = (url.searchParams.get("accountId") || "main").trim();

    const existing = activePairs.get(accountId);
    if (!existing) {
      return NextResponse.json({
        exited: true,
        exitCode: null,
        output: "[Nenhum pareamento ativo. Clique em 'Parear via QR Code' para iniciar]",
      });
    }

    return NextResponse.json({
      exited: existing.exited,
      exitCode: existing.exitCode,
      output: stripAnsi(existing.output),
      startedAt: existing.startedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// ─── POST (control process lifecycle: start / stop) ──────────────────────
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    const accountId = (url.searchParams.get("accountId") || "main").trim();

    if (action === "start") {
      const existing = activePairs.get(accountId);
      if (existing && !existing.exited) {
        return NextResponse.json({
          success: true,
          message: "Processo de pareamento já está ativo para esta conta",
          output: stripAnsi(existing.output),
          exited: false,
        });
      }

      const config = readOpenClawConfig();
      // --verbose so Baileys socket state ("Connecting...", QR retries) shows
      // in the terminal panel instead of silently hanging.
      const command = `${config.openclawBin} channels login --channel whatsapp --account ${accountId} --verbose`;
      // openclaw's `channels login` (loginWeb) does NOT support a --force
      // flag — if creds.json already exists under ~/.openclaw/credentials/
      // whatsapp/<id>/, Baileys reuses them instead of emitting a QR. When
      // those creds are stale/logged-out the socket just spins forever
      // and the UI sees only the OpenClaw banner. Force a fresh QR by
      // logging out FIRST (idempotent — no-op when there's nothing).
      const logoutCommand = `${config.openclawBin} channels logout --channel whatsapp --account ${accountId}`;

      // Sanitize openclaw.json before spawning CLI to prevent schema validation errors
      try {
        const { path: configPath } = resolveOpenClawAgentsConfigPath();
        if (fs.existsSync(configPath)) {
          const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          if (migrateWhatsappAccountsFromConfig(rawConfig)) {
            fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), "utf-8");
          }
        }
      } catch (err) {
        console.error("Failed to auto-sanitize openclaw.json before pairing:", err);
      }

      const envPath = buildOpenClawEnvPath();
      const childEnv = {
        ...process.env,
        PATH: envPath,
        OPENCLAW_DIR: config.openclawDir,
        OPENCLAW_WORKSPACE: config.openclawWorkspace,
      };

      // State has to exist before we kick off async work so polling sees
      // install progress while it streams.
      const state: PairState = {
        child: null as unknown as ChildProcess,
        output: "",
        startedAt: Date.now(),
        exited: false,
        exitCode: null,
      };
      activePairs.set(accountId, state);

      const hasScript = fs.existsSync("/usr/bin/script") || fs.existsSync("/bin/script");
      const ptyWrap = (cmd: string) =>
        hasScript ? `script -qfc ${JSON.stringify(cmd)} /dev/null` : cmd;
      const spawnEnv: NodeJS.ProcessEnv = {
        ...childEnv,
        TERM: process.env.TERM || "xterm-256color",
      };

      // Run logout first to clear any stale creds, then login. Both wrapped
      // in PTY (script -qfc) because the WhatsApp plugin uses @clack/prompts
      // + a terminal QR renderer that need a TTY.
      const spawnLogout = () =>
        new Promise<void>((resolve) => {
          const wrapped = ptyWrap(logoutCommand);
          state.output += `$ ${wrapped}\n`;
          const child = spawn(wrapped, {
            cwd: config.openclawDir,
            env: spawnEnv,
            shell: true,
          });
          state.child = child;
          child.stdout?.on("data", (data) => {
            state.output += data.toString();
          });
          child.stderr?.on("data", (data) => {
            state.output += data.toString();
          });
          child.on("exit", () => {
            // Logout exits 0 even when there was nothing to log out from —
            // either way we proceed to login. Don't fail the whole flow on
            // logout errors; the login spawn will surface anything fatal.
            state.output += `\n[logout finalizado, iniciando login…]\n\n`;
            resolve();
          });
          child.on("error", (err) => {
            state.output += `\n[logout falhou: ${err.message} — tentando login mesmo assim]\n\n`;
            resolve();
          });
        });

      const spawnLogin = () => {
        const wrapped = ptyWrap(command);
        state.output += `$ ${wrapped}\n\n`;
        const child = spawn(wrapped, {
          cwd: config.openclawDir,
          env: spawnEnv,
          shell: true,
        });
        state.child = child;

        child.stdout?.on("data", (data) => {
          state.output += data.toString();
        });
        child.stderr?.on("data", (data) => {
          state.output += data.toString();
        });
        child.on("exit", (code) => {
          state.exited = true;
          state.exitCode = code;
          state.output += `\n[Processo encerrado com código de saída: ${code}]\n`;
          if (code !== 0 && code !== null) {
            state.output +=
              "\nDica: se o terminal saiu sem mostrar QR, clique Reparar config e tente de novo.\n" +
              "No VPS dá pra rodar manualmente: " +
              `${config.openclawBin} channels login --channel whatsapp --account ${accountId} --verbose\n`;
          }
        });
        child.on("error", (err) => {
          state.exited = true;
          state.output += `\n[Erro ao iniciar CLI]: ${err.message}\n`;
        });
      };

      const runLogoutThenLogin = async () => {
        await spawnLogout();
        spawnLogin();
      };

      // Pre-flight: WhatsApp channel needs @openclaw/whatsapp installed,
      // otherwise `channels login --channel whatsapp` silently exits with
      // no QR — which is what bit us. Auto-install when missing and stream
      // the npm output into the same terminal so the user sees progress.
      const probe = isPluginInstalled(WHATSAPP_PLUGIN);
      if (probe.installed) {
        void runLogoutThenLogin();
      } else {
        const reason = probe.error
          ? `Não consegui verificar plugins (${probe.error}). Tentando instalar de qualquer jeito.`
          : `Plugin ${WHATSAPP_PLUGIN} não está instalado — sem ele o CLI sai silencioso.`;
        state.output +=
          `[Pre-flight] ${reason}\n` +
          `[Pre-flight] Rodando: ${config.openclawBin} plugins install ${WHATSAPP_PLUGIN}\n\n`;

        const { child: installer, done } = installPluginStreaming(
          WHATSAPP_PLUGIN,
          (chunk) => {
            state.output += chunk;
          },
        );
        state.child = installer;

        done.then((result) => {
          state.output += `\n[Pre-flight] Install ${
            result.ok ? "OK" : `falhou (exit ${result.exitCode})`
          } em ${(result.durationMs / 1000).toFixed(1)}s\n\n`;
          if (!result.ok) {
            state.exited = true;
            state.exitCode = result.exitCode ?? -1;
            return;
          }
          void runLogoutThenLogin();
        }).catch((err) => {
          state.exited = true;
          state.output += `\n[Pre-flight] Erro inesperado: ${
            err instanceof Error ? err.message : String(err)
          }\n`;
        });
      }

      // Auto-terminate process after 5 minutes to prevent leaks
      setTimeout(() => {
        const p = activePairs.get(accountId);
        if (p && !p.exited) {
          try {
            p.child.kill("SIGKILL");
          } catch {}
          p.exited = true;
          p.exitCode = -1;
          p.output += "\n[Sessão de pareamento expirou após 5 minutos]\n";
        }
      }, 300000);

      // Quick delay to capture initial output (e.g. ASCII QR code generation)
      await new Promise((r) => setTimeout(r, 600));

      return NextResponse.json({
        success: true,
        message: "Processo de pareamento iniciado",
        output: stripAnsi(state.output),
        exited: state.exited,
      });
    }

    if (action === "stop") {
      const existing = activePairs.get(accountId);
      if (existing) {
        if (!existing.exited) {
          try {
            existing.child.kill("SIGKILL");
          } catch {}
          existing.exited = true;
          existing.exitCode = -1;
          existing.output += "\n[Cancelado pelo usuário]\n";
        }
        activePairs.delete(accountId);
        return NextResponse.json({ success: true, message: "Pareamento interrompido" });
      }
      return NextResponse.json({ success: true, message: "Nenhum processo ativo para parar" });
    }

    return NextResponse.json(
      { error: `Ação desconhecida: "${action}". Use ?action=start ou ?action=stop` },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
