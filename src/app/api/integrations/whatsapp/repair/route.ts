/**
 * POST /api/integrations/whatsapp/repair
 *
 * One-shot self-repair sequence so the user can fix everything from the UI:
 *   1. Install missing OpenClaw plugins (@openclaw/whatsapp, @openclaw/acpx)
 *      — required for the WhatsApp channel runtime + ACP backend.
 *   2. Sweep openclaw.json:
 *        - migrate AtlasDeck-only WhatsApp fields to local storage
 *        - whitelist `whatsapp_login` in gateway.tools.allow
 *        - flip plugins.entries.{whatsapp,acpx}.enabled = true (external
 *          plugins don't auto-activate)
 *   3. Restart the gateway so the freshly enabled plugins register their
 *      runtime tools, and `whatsapp_login` becomes available over
 *      /tools/invoke.
 *   4. Run `openclaw config validate` and surface the canonical output.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { sweepOpenClawConfig } from "@/lib/openclaw-config-sweep";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import {
  WHATSAPP_PLUGIN,
  ACPX_PLUGIN,
  isPluginInstalled,
  installPluginSync,
} from "@/lib/openclaw-plugins";
import { restartGateway } from "@/lib/gateway-control";

export const dynamic = "force-dynamic";

interface PluginInstallReport {
  package: string;
  alreadyInstalled: boolean;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

function tailLines(text: string, max: number): string {
  return text.split("\n").slice(-max).join("\n").trim();
}

export async function POST() {
  try {
    // 1. Install required plugins — idempotent. Sync install is fine; both
    //    plugins together are < 60s on a warm cache and 1-2 minutes cold.
    const installs: PluginInstallReport[] = [];
    for (const pkg of [WHATSAPP_PLUGIN, ACPX_PLUGIN]) {
      const probe = isPluginInstalled(pkg);
      if (probe.installed) {
        installs.push({
          package: pkg,
          alreadyInstalled: true,
          ok: true,
          exitCode: 0,
          durationMs: 0,
          outputTail: "",
        });
        continue;
      }
      const r = installPluginSync(pkg);
      installs.push({
        package: pkg,
        alreadyInstalled: false,
        ok: r.ok,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        outputTail: tailLines(r.output, 6),
      });
    }

    // 2. Sweep config (migrate, allow tool, enable plugins).
    const sweep = sweepOpenClawConfig();

    // 3. Restart gateway so plugin enablement takes effect and the WhatsApp
    //    runtime registers its agent tools (including whatsapp_login).
    let restartOk: boolean | null = null;
    let restartMessage = "";
    try {
      const restart = await restartGateway();
      restartOk = restart.success;
      restartMessage = restart.success
        ? `Gateway reiniciado via ${restart.runtime}`
        : `Restart falhou (${restart.runtime}): ${tailLines(restart.output, 3)}`;
    } catch (e) {
      restartOk = false;
      restartMessage = e instanceof Error ? e.message : String(e);
    }

    // 4. Validate config (post-everything).
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

    const allInstallsOk = installs.every((i) => i.ok);
    const ok = sweep.ran && allInstallsOk && validateOk !== false;

    return NextResponse.json({
      ok,
      installs,
      sweep,
      restart: { ok: restartOk, message: restartMessage },
      validate: { ok: validateOk, output: validateOutput },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
