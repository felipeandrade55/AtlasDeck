/**
 * POST /api/integrations/whatsapp/repair
 *
 * One-shot self-repair of channels.whatsapp.accounts in openclaw.json:
 *   1. Reads ~/.openclaw/openclaw.json
 *   2. Moves AtlasDeck-only fields (phoneNumber/chatId/dmPolicy) to local storage
 *   3. Wipes any other field OpenClaw v2026.5.12+ rejects, leaving accounts.<id>: {}
 *   4. Re-runs `openclaw config validate` and reports the canonical output
 *
 * Driven by the "Reparar config OpenClaw" button so the user can fix the
 * gateway from the UI without ssh'ing into the VPS.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { sweepOpenClawConfig } from "@/lib/openclaw-config-sweep";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const sweep = sweepOpenClawConfig();

    let validateOk: boolean | null = null;
    let validateOutput = "";
    try {
      const { openclawBin, openclawDir } = readOpenClawConfig();
      const result = spawnSync(openclawBin, ["config", "validate"], {
        cwd: openclawDir,
        env: process.env,
        encoding: "utf-8",
        timeout: 8000,
      });
      validateOutput = `${result.stdout || ""}${result.stderr || ""}`.trim();
      validateOk = result.error ? null : (result.status ?? 1) === 0;
    } catch (e) {
      validateOutput = e instanceof Error ? e.message : String(e);
    }

    return NextResponse.json({
      ok: sweep.ran && validateOk !== false,
      sweep,
      validate: {
        ok: validateOk,
        output: validateOutput,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
