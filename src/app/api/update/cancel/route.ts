/**
 * Force-cancel an in-progress update.
 *
 *   POST /api/update/cancel
 *     → kills the deploy.sh process group (SIGTERM, then SIGKILL after 2s)
 *     → writes a terminal "error" status to live-status.json so the UI
 *       transitions out of "updating" state
 *
 * Use case: build phase appears stuck (no heartbeat for >60s) and the
 * user wants to abort rather than wait indefinitely. The deploy.sh
 * detached process group is killed; partial state on disk (.next, etc.)
 * is left as-is — the user can re-run the update afterwards.
 */
import { NextResponse } from "next/server";
import {
  readLiveStatus,
  updateHistoryEntry,
  writeLiveStatus,
} from "@/lib/update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (pid <= 0) return false;
  try {
    // Negative PID = process group. deploy.sh is spawned with
    // detached: true which makes it the leader of its own group, so
    // killing -pid takes down the whole tree (npm, node build, etc.).
    process.kill(-pid, signal);
    return true;
  } catch {
    // Fallback: try direct PID
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function POST() {
  const live = readLiveStatus();
  if (!live) {
    return NextResponse.json({ error: "Nenhum update em andamento" }, { status: 404 });
  }
  if (live.status !== "running") {
    return NextResponse.json({ error: `Update já está em estado '${live.status}'` }, { status: 409 });
  }

  const pid = live.pid;
  const wasAlive = await isProcessAlive(pid);

  if (wasAlive) {
    // SIGTERM first to give the script a chance to clean up
    killProcessGroup(pid, "SIGTERM");
    // After 2s, SIGKILL if still around
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await isProcessAlive(pid)) {
      killProcessGroup(pid, "SIGKILL");
    }
  }

  const completedAt = new Date().toISOString();
  const errorMsg = wasAlive
    ? "Update cancelado pelo usuário"
    : "Update marcado como falho — processo não estava mais ativo";

  const terminal = {
    ...live,
    status: "error" as const,
    completedAt,
    error: errorMsg,
  };
  writeLiveStatus(terminal);

  try {
    updateHistoryEntry(live.historyId, {
      status: "error",
      completedAt,
      error: errorMsg,
    });
  } catch {}

  return NextResponse.json({
    success: true,
    killed: wasAlive,
    message: errorMsg,
  });
}
