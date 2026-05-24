import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

import { isUpdateRunning } from "@/lib/update";
import { isRestoreRunning } from "@/lib/restore";
import { restoreUploadsDir } from "@/lib/restore";
import { triggerRestore } from "@/lib/restore-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/backup/restore/start
 * Body: { uploadId: string, createSafetyBackup?: boolean, confirm: "RESTAURAR" }
 *
 * Spawns scripts/restore.sh detached and returns sessionId/pid. Gates:
 *   - Body must contain confirm === "RESTAURAR" (defense in depth — UI checkbox)
 *   - 409 if an update or another restore is already running
 *   - 404 if the upload file no longer exists
 */
export async function POST(req: NextRequest) {
  let body: { uploadId?: unknown; createSafetyBackup?: unknown; confirm?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const createSafetyBackup = body.createSafetyBackup !== false;
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
    return NextResponse.json({ error: "uploadId inválido" }, { status: 400 });
  }

  if (confirm !== "RESTAURAR") {
    return NextResponse.json(
      { error: "Confirmação faltando. O cliente deve enviar confirm='RESTAURAR'." },
      { status: 400 }
    );
  }

  if (isUpdateRunning()) {
    return NextResponse.json(
      { error: "Existe um update em andamento. Aguarde a conclusão antes de restaurar." },
      { status: 409 }
    );
  }
  if (isRestoreRunning()) {
    return NextResponse.json(
      { error: "Já existe um restore em andamento." },
      { status: 409 }
    );
  }

  const archivePath = path.join(restoreUploadsDir(), `${uploadId}.tar.gz`);
  if (!fs.existsSync(archivePath)) {
    return NextResponse.json(
      { error: "Upload não encontrado — faça o upload novamente." },
      { status: 404 }
    );
  }

  const result = await triggerRestore({ uploadId, archivePath, createSafetyBackup });

  if (!result.ok) {
    const status =
      result.reason === "already-running" ? 409 :
      result.reason === "preview-failed" ? 400 :
      result.reason === "no-pid" ? 500 :
      500;
    return NextResponse.json(
      {
        error: result.error || "Falha ao iniciar restore",
        reason: result.reason,
        sessionId: result.sessionId,
      },
      { status }
    );
  }

  return NextResponse.json({
    sessionId: result.sessionId,
    pid: result.pid,
  });
}
