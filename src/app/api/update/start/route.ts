import { NextResponse } from "next/server";
import { triggerUpdate } from "@/lib/update-trigger";
import { buildInitialPhases, readUpdateConfig } from "@/lib/update";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Endpoint para iniciar update manualmente via UI. A lógica real está em
 * `lib/update-trigger.triggerUpdate()`, compartilhada com o auto-update do
 * scheduler.
 */
export async function POST() {
  const result = await triggerUpdate("manual");

  if (!result.ok) {
    if (result.reason === "already-running") {
      return NextResponse.json(
        { error: "Já existe um update em andamento", sessionId: result.sessionId },
        { status: 409 }
      );
    }
    if (result.reason === "no-pid") {
      return NextResponse.json(
        { error: "Falha ao iniciar processo de update (sem PID)" },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: result.error || "Falha ao iniciar update" },
      { status: 500 }
    );
  }

  const config = readUpdateConfig();
  return NextResponse.json({
    sessionId: result.sessionId,
    historyId: result.historyId,
    pid: result.pid,
    fromSha: result.fromSha,
    toSha: result.toSha,
    phases: buildInitialPhases(config.backupBeforeUpdate),
  });
}
