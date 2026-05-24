import { NextResponse } from "next/server";
import { readRestoreLiveStatus, writeRestoreLiveStatus } from "@/lib/restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/backup/restore/cancel
 *
 * Sends SIGTERM to the restore process group, waits 5s, then SIGKILL if still
 * alive. The bash trap inside restore.sh emits a terminal "fail" via phase
 * status before exiting, so the UI gets a clean shutdown signal.
 *
 * Note: cancel is only safe up to and including the `extract` phase. After
 * `apply-data` starts mutating disk, the user should either let the restore
 * finish or rely on the rollback if a phase fails on its own.
 */
export async function POST() {
  const live = readRestoreLiveStatus();
  if (!live || live.status !== "running") {
    return NextResponse.json(
      { error: "Nenhum restore ativo para cancelar" },
      { status: 404 }
    );
  }
  if (!live.pid || live.pid <= 0) {
    return NextResponse.json(
      { error: "PID do restore desconhecido" },
      { status: 500 }
    );
  }

  // After apply-data, blocking cancel — too risky.
  const destructivePhases = new Set(["apply-data", "apply-env", "apply-home", "start-app", "verify"]);
  if (destructivePhases.has(live.currentPhase)) {
    return NextResponse.json(
      {
        error:
          `Não é seguro cancelar durante a fase "${live.currentPhase}". ` +
          "Aguarde a conclusão — em caso de falha, o rollback será automático.",
      },
      { status: 409 }
    );
  }

  try {
    // Negative PID = process group
    try { process.kill(-live.pid, "SIGTERM"); } catch { process.kill(live.pid, "SIGTERM"); }

    setTimeout(() => {
      try { process.kill(live.pid, 0); } catch { return; }
      try { process.kill(-live.pid, "SIGKILL"); } catch { try { process.kill(live.pid, "SIGKILL"); } catch {} }
    }, 5000);

    writeRestoreLiveStatus({
      ...live,
      status: "error",
      error: "Restore cancelado pelo usuário",
      completedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
