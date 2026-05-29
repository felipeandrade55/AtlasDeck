/**
 * POST /api/telegram/auto-rotate
 *
 * Toggles the agent-load watchdog's auto-rotation behavior at runtime.
 * Default is *off* (opt-in) so the rotation primitive can be vetted
 * manually before letting the watchdog act unsupervised. The current
 * state is reported in the diagnose endpoint under `agentLoadWatchdog`.
 *
 * Body: { enabled: boolean }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getAgentLoadWatchdogState,
  setAgentLoadAutoRotate,
} from "@/lib/agent-load-watchdog";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body JSON inválido — espera { enabled: boolean }" },
      { status: 400 },
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Campo `enabled` é obrigatório e precisa ser boolean." },
      { status: 400 },
    );
  }
  setAgentLoadAutoRotate(body.enabled);
  const state = getAgentLoadWatchdogState();
  return NextResponse.json({
    enabled: state.enabled,
    started: state.started,
  });
}
