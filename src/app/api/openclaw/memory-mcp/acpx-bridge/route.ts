/**
 * POST /api/openclaw/memory-mcp/acpx-bridge
 *   body: { enabled: boolean }
 *
 * Sets `plugins.entries.acpx.config.pluginToolsMcpBridge` in openclaw.json.
 * Required to let the main agent (when ACPX-backed) actually see MCP
 * tools that are registered globally in `mcp.servers`. Without this
 * flag, OpenClaw spawns the MCP server fine but never exposes the
 * tools to the LLM's tool list.
 *
 * The patch is surgical: we only touch the one nested path. All other
 * openclaw.json fields are preserved.
 */
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getOpenClawDir } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  enabled?: boolean;
}

export async function POST(request: Request) {
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {}
  const enabled = body.enabled !== false;
  const filePath = path.join(getOpenClawDir(), "openclaw.json");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `openclaw.json não acessível: ${err instanceof Error ? err.message : err}`,
      },
      { status: 404 },
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `openclaw.json não é JSON válido: ${err instanceof Error ? err.message : err}`,
      },
      { status: 422 },
    );
  }

  const plugins =
    (parsed.plugins as Record<string, unknown> | undefined) ?? {};
  const entries =
    (plugins.entries as Record<string, unknown> | undefined) ?? {};
  const acpx = (entries.acpx as Record<string, unknown> | undefined) ?? {};
  const acpxConfig =
    (acpx.config as Record<string, unknown> | undefined) ?? {};
  const before = acpxConfig.pluginToolsMcpBridge;
  if (before === enabled) {
    return NextResponse.json({
      ok: true,
      changed: false,
      before,
      after: enabled,
    });
  }

  const next: Record<string, unknown> = {
    ...parsed,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        acpx: {
          ...acpx,
          config: {
            ...acpxConfig,
            pluginToolsMcpBridge: enabled,
          },
        },
      },
    },
  };

  // backup
  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {}

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);

  // Verify the write actually stuck. If some other process (gateway
  // watchdog, openclaw doctor) is racing us, we'll see the value
  // already different on re-read. Worth surfacing — silent revert was
  // the entire reason the user clicked the button twice without effect.
  let persisted: boolean | null = null;
  let persistedValue: unknown = null;
  try {
    const verifyRaw = fs.readFileSync(filePath, "utf-8");
    const verify = JSON.parse(verifyRaw) as Record<string, unknown>;
    const vp = verify.plugins as Record<string, unknown> | undefined;
    const ve = (vp?.entries as Record<string, unknown> | undefined) ?? {};
    const va = (ve.acpx as Record<string, unknown> | undefined) ?? {};
    const vc = (va.config as Record<string, unknown> | undefined) ?? {};
    persistedValue = vc.pluginToolsMcpBridge;
    persisted = persistedValue === enabled;
  } catch {
    persisted = null;
  }

  return NextResponse.json({
    ok: true,
    changed: true,
    before: before ?? null,
    after: enabled,
    persisted,
    persistedValue,
    reloadHint:
      "Reinicie o gateway pelo botão Reverificar pra mudança ter efeito.",
  });
}
