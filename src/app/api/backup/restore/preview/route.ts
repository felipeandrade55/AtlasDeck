import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

import { previewRestore } from "@/lib/backup";
import { restoreUploadsDir } from "@/lib/restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backup/restore/preview?uploadId=<uuid>
 *
 * Reads the upload by ID and returns the restore plan (origin metadata,
 * mappings, platform mismatch, archive size). Does not extract or mutate
 * anything — safe to call repeatedly.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId || !/^[0-9a-f-]{36}$/i.test(uploadId)) {
    return NextResponse.json({ error: "uploadId inválido" }, { status: 400 });
  }

  const archivePath = path.join(restoreUploadsDir(), `${uploadId}.tar.gz`);
  if (!fs.existsSync(archivePath)) {
    return NextResponse.json(
      { error: "Upload não encontrado — talvez tenha sido limpo. Faça o upload novamente." },
      { status: 404 }
    );
  }

  try {
    const preview = await previewRestore(archivePath);
    const stat = fs.statSync(archivePath);
    return NextResponse.json({
      ...preview,
      archiveSizeBytes: stat.size,
      uploadId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
