/**
 * POST /api/openclaw/auto-fix
 *
 * One-click backend for the "Corrigir automaticamente" buttons in the
 * chat banners. The user never has to open a terminal — they click the
 * button, this route runs the patch on the server, restarts the
 * gateway, and reports back what changed.
 *
 * Body shape (all fields optional, defaults to "all"):
 *   {
 *     fix?: "streaming" | "heartbeat" | "all",
 *     restart?: boolean   // default true
 *   }
 *
 * Response: structured report so the UI can render exactly what was
 * done ("já estava correto", "patcheei X", "reinicei o gateway").
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ensureBackendAuthBypass,
  ensureHeartbeatRule,
  ensureStreamingConfig,
  restartGateway,
  type BackendAuthFixReport,
  type HeartbeatFixReport,
  type RestartReport,
  type StreamingFixReport,
} from "@/lib/openclaw-auto-fix";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AutoFixBody {
  fix?: "streaming" | "heartbeat" | "auth" | "all";
  restart?: boolean;
}

interface AutoFixResponse {
  ok: boolean;
  applied: ("streaming" | "heartbeat" | "auth")[];
  streaming?: StreamingFixReport;
  heartbeat?: HeartbeatFixReport;
  auth?: BackendAuthFixReport;
  restart?: RestartReport;
}

export async function POST(req: NextRequest) {
  let body: AutoFixBody = {};
  try {
    const raw = await req.text();
    body = raw ? (JSON.parse(raw) as AutoFixBody) : {};
  } catch {
    // Empty/invalid body is fine — fall through to defaults.
  }

  const fix = body.fix ?? "all";
  const wantRestart = body.restart !== false; // default: restart
  const applied: ("streaming" | "heartbeat" | "auth")[] = [];

  const result: AutoFixResponse = { ok: true, applied };

  // 1. Streaming config
  if (fix === "streaming" || fix === "all") {
    const r = ensureStreamingConfig();
    result.streaming = r;
    if (!r.ok) result.ok = false;
    if (r.ok && !r.alreadyCorrect) applied.push("streaming");
  }

  // 1b. Backend auth bypass (fixes "device identity required" handshake)
  if (fix === "auth" || fix === "all") {
    const r = ensureBackendAuthBypass();
    result.auth = r;
    if (!r.ok) result.ok = false;
    if (r.ok && !r.alreadyCorrect) applied.push("auth");
  }

  // 2. Heartbeat guard
  if (fix === "heartbeat" || fix === "all") {
    const r = ensureHeartbeatRule();
    result.heartbeat = r;
    if (!r.ok) result.ok = false;
    if (r.ok && !r.alreadyCorrect) applied.push("heartbeat");
  }

  // 3. Restart only when something actually changed AND caller wants it.
  // Skipping restart on no-op keeps the gateway state stable for the
  // common case where the user clicks the button after the issue has
  // already been auto-fixed during deploy.
  if (wantRestart && (applied.length > 0 || body.fix !== undefined)) {
    result.restart = await restartGateway();
    if (!result.restart.ok) {
      // We don't flip result.ok to false because the patch succeeded —
      // failing to restart is a softer signal. The UI surfaces the
      // restart error separately so the user can do it by hand if
      // needed.
    }
  }

  // Mission Control activity record for auditing.
  try {
    logActivity(
      "config",
      applied.length > 0
        ? `Auto-fix OpenClaw: ${applied.join(", ")}`
        : "Auto-fix OpenClaw: nada a fazer (já estava OK)",
      result.ok ? "success" : "error",
      {
        agent: "system",
        metadata: {
          fix,
          applied,
          restart: result.restart?.method ?? "skipped",
        },
      },
    );
  } catch (err) {
    console.warn("[auto-fix] logActivity failed:", err);
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
