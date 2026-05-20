/**
 * Install Ollama on Linux hosts.
 *
 *   POST /api/memory/ollama/install     → starts the official install script, returns { id }
 *   GET  /api/memory/ollama/install?id  → poll status (running | ok | fail) + tail of logs
 *
 * Soft-fails on macOS/Windows by returning { supported: false, hint }.
 * The actual command is the documented `curl -fsSL https://ollama.com/install.sh | sh`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getInstallStatus, startInstall } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = startInstall();
  if (!result.supported) {
    return NextResponse.json(
      { error: "Auto-install não suportado nesta plataforma", hint: result.hint },
      { status: 400 },
    );
  }
  return NextResponse.json({ id: result.id, status: "running" });
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const status = getInstallStatus(id);
  if (!status) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
