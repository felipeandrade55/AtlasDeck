/**
 * POST /api/integrations/whatsapp/install-plugin
 *
 * Runs `openclaw plugins install @openclaw/whatsapp` (or another package
 * passed in the body) and returns the captured output. Synchronous on
 * purpose — npm install of a single OpenClaw plugin takes < 90s and the
 * UI just shows a spinner.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  WHATSAPP_PLUGIN,
  installPluginSync,
  isPluginInstalled,
} from "@/lib/openclaw-plugins";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { package?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK
  }

  const pkg = (body.package || WHATSAPP_PLUGIN).trim();
  if (!pkg) {
    return NextResponse.json({ error: "Package name vazio" }, { status: 400 });
  }

  try {
    const pre = isPluginInstalled(pkg);
    if (pre.installed) {
      return NextResponse.json({
        ok: true,
        alreadyInstalled: true,
        package: pkg,
        output: pre.rawOutput,
      });
    }

    const result = installPluginSync(pkg);
    const post = isPluginInstalled(pkg);

    return NextResponse.json({
      ok: result.ok && post.installed,
      alreadyInstalled: false,
      package: pkg,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.output,
      verifiedInstalled: post.installed,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
