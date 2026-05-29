import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

interface PairState {
  child: ChildProcess;
  output: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

// Global active pairs map, surviving Next.js fast-refresh during dev
const activePairs = (global as any).activeWhatsappPairs || new Map<string, PairState>();
(global as any).activeWhatsappPairs = activePairs;

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
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
      const child = spawn(
        config.openclawBin,
        ["channels", "login", "--channel", "whatsapp", "--account", accountId],
        {
          cwd: config.openclawDir,
          env: {
            ...process.env,
            OPENCLAW_DIR: config.openclawDir,
            OPENCLAW_WORKSPACE: config.openclawWorkspace,
          },
          shell: true,
        }
      );

      const state: PairState = {
        child,
        output: "",
        startedAt: Date.now(),
        exited: false,
        exitCode: null,
      };

      child.stdout?.on("data", (data) => {
        state.output += data.toString();
      });

      child.stderr?.on("data", (data) => {
        state.output += data.toString();
      });

      child.on("exit", (code) => {
        state.exited = true;
        state.exitCode = code;
      });

      child.on("error", (err) => {
        state.exited = true;
        state.output += `\n[Erro ao iniciar CLI]: ${err.message}\n`;
      });

      activePairs.set(accountId, state);

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
