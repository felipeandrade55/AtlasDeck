/**
 * POST /api/openclaw/memory-mcp/restart-gateway
 *
 * Force-restart the OpenClaw gateway without touching any config.
 * Needed because the orchestrator's activate flow only restarts when
 * IT mutated something — but when the user fixes config externally
 * (CLI, manual edit) or already-correct files need a reload-to-RAM
 * (e.g. after the ACPX bridge was flipped in another step), nothing
 * was forcing a restart.
 *
 * Returns the same shape as the activate endpoint so the UI can
 * reuse rendering.
 */
import { NextResponse } from "next/server";
import { restartGateway } from "@/lib/gateway-control";
import { waitForGateway } from "@/lib/openclaw-gateway-wait";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const restart = await restartGateway();
  let wait;
  if (restart.success) {
    wait = await waitForGateway({ timeoutMs: 15_000 });
  } else {
    wait = { skipped: true as const };
  }

  const summary = [
    restart.success ? `reload via ${restart.runtime}` : `reload falhou (${restart.runtime})`,
    "skipped" in wait
      ? "wait pulado"
      : wait.ready
      ? `gateway pronto em ${wait.elapsedMs}ms`
      : `gateway não voltou em ${wait.elapsedMs}ms`,
  ].join(" · ");

  const ok = restart.success && (!("skipped" in wait) ? wait.ready : true);
  logActivity(
    'command',
    `Reinício do gateway (memory MCP) ${ok ? 'concluído' : 'falhou'}`,
    ok ? 'success' : 'error',
    { duration_ms: "elapsedMs" in wait ? wait.elapsedMs : undefined, metadata: { runtime: restart.runtime } }
  );

  return NextResponse.json({
    ok,
    restart,
    wait,
    summary,
  });
}
