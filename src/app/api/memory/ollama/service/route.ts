/**
 * Service control for the Ollama systemd unit.
 *
 *   POST /api/memory/ollama/service
 *     Body: { action: "start" | "stop" | "restart" | "enable" | "disable" | "status" }
 *     → { supported, action, ok, active, enabled, message }
 *
 * Linux-only. macOS/Windows return supported=false with a hint —
 * Ollama there is a GUI app, not a systemd service.
 *
 * Permissions: when AtlasDeck runs as root (typical on VPS), systemctl
 * works directly. Non-root setups need a sudoers entry like:
 *   <user> ALL=(ALL) NOPASSWD: /bin/systemctl start ollama, \
 *                              /bin/systemctl stop ollama, ...
 * The systemctl error is surfaced verbatim so the user knows what to fix.
 */
import { NextRequest, NextResponse } from "next/server";
import { controlService, type ServiceAction } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_ACTIONS: ServiceAction[] = [
  "start",
  "stop",
  "restart",
  "enable",
  "disable",
  "status",
];

export async function POST(request: NextRequest) {
  let body: { action?: string };
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action as ServiceAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const result = await controlService(action);
  // 200 even on systemctl failure — the body conveys ok=false plus the
  // error message. Reserves non-2xx for malformed requests.
  if (!result.supported) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
