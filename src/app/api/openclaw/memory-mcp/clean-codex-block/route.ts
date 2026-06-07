/**
 * POST /api/openclaw/memory-mcp/clean-codex-block
 *
 * Remove the `codex` sub-block from `mcp.servers.atlasdeck-memory` in
 * openclaw.json. Per OpenClaw docs (gateway/configuration-reference.md):
 *
 *   "Non-empty codex.agents limits the server to the listed OpenClaw
 *    agent ids. Empty, blank, or invalid scoped agent lists are
 *    rejected by config validation and omitted by the runtime
 *    projection path instead of becoming global. Omit the block to
 *    keep the server projected for every Codex app-server agent."
 *
 * So if anything ever wrote `codex: {}` or `codex: { agents: [] }`,
 * the server is hidden from EVERY agent — including main. This route
 * removes the block entirely, restoring global projection.
 *
 * Preserves every other field of the entry. Backup .bak before write.
 */
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getOpenClawDir } from "@/lib/openclaw-config";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_NAME = "atlasdeck-memory";

export async function POST() {
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

  const mcp = parsed.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, Record<string, unknown>> | undefined;
  const entry = servers?.[SERVER_NAME];
  if (!entry) {
    return NextResponse.json(
      {
        ok: false,
        error: `Entry mcp.servers.${SERVER_NAME} ausente — clique em Reverificar primeiro.`,
      },
      { status: 404 },
    );
  }
  const before = entry.codex ?? null;
  if (before === null) {
    return NextResponse.json({
      ok: true,
      changed: false,
      message: "Bloco codex já estava ausente.",
    });
  }

  const { codex: _codex, ...rest } = entry;
  void _codex;
  const nextServers = { ...servers, [SERVER_NAME]: rest };
  const next = {
    ...parsed,
    mcp: {
      ...(mcp ?? {}),
      servers: nextServers,
    },
  };

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {}

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);

  logActivity('memory', 'Bloco codex removido do atlasdeck-memory (MCP)', 'success', { metadata: { removed: before } });

  return NextResponse.json({
    ok: true,
    changed: true,
    removed: before,
    reloadHint:
      "Clique em Reiniciar gateway. Depois inicie uma conversa NOVA no Telegram — projeções de Codex são fixadas quando a thread abre, não recomputadas nas turns existentes.",
  });
}
