import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

import { restoreUploadsDir } from "@/lib/restore";
import { logActivity } from "@/lib/activities-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800; // 30 min for multi-GB uploads

/**
 * Streams the request body straight to disk under data/.restore-uploads/<uuid>.tar.gz
 * and validates that:
 *   1. The first two bytes match the gzip magic (1f 8b)
 *   2. `tar -tzf` lists the archive without errors
 *   3. The archive contains `data/backup-origin.json` (AtlasDeck marker)
 *
 * Returns 4xx if any check fails (deleting the partial file first). On success
 * returns `{ uploadId, sizeBytes }` which the client uses to call the preview
 * and start endpoints.
 */
export async function POST(req: NextRequest) {
  const uploadId = randomUUID();
  const uploadsDir = restoreUploadsDir();
  fs.mkdirSync(uploadsDir, { recursive: true });
  const targetPath = path.join(uploadsDir, `${uploadId}.tar.gz`);

  if (!req.body) {
    return NextResponse.json({ error: "Corpo da requisição vazio" }, { status: 400 });
  }

  let bytesWritten = 0;
  try {
    const fileStream = fs.createWriteStream(targetPath);
    // Bridge Fetch's web stream into Node's stream via Readable.fromWeb.
    // We cast through `any` because the Node typings expect their own
    // `ReadableStream` interface (with asyncIterator helpers) while DOM lib
    // ships only the streams-spec shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeStream = Readable.fromWeb(req.body as any);
    nodeStream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
    });
    await pipeline(nodeStream, fileStream);
  } catch (err) {
    try { fs.unlinkSync(targetPath); } catch {}
    return NextResponse.json(
      { error: `Falha ao gravar upload: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  if (bytesWritten < 2) {
    try { fs.unlinkSync(targetPath); } catch {}
    return NextResponse.json(
      { error: "Upload vazio ou interrompido" },
      { status: 400 }
    );
  }

  // Magic bytes 1f 8b
  try {
    const fd = fs.openSync(targetPath, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      fs.unlinkSync(targetPath);
      return NextResponse.json(
        { error: "Arquivo não é um gzip válido (magic bytes incorretos)" },
        { status: 400 }
      );
    }
  } catch (err) {
    try { fs.unlinkSync(targetPath); } catch {}
    return NextResponse.json(
      { error: `Falha ao validar magic bytes: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // tar -tzf lista o conteúdo + verifica que contém backup-origin.json
  try {
    const listing = execFileSync("tar", ["-tzf", targetPath], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    if (!listing.split("\n").some((line) => line.endsWith("data/backup-origin.json"))) {
      try { fs.unlinkSync(targetPath); } catch {}
      return NextResponse.json(
        {
          error:
            "Arquivo não contém data/backup-origin.json — não parece um backup do AtlasDeck. " +
            "Backups antigos (anteriores à feature de origin-manifest) não são suportados.",
        },
        { status: 400 }
      );
    }
  } catch (err) {
    try { fs.unlinkSync(targetPath); } catch {}
    return NextResponse.json(
      {
        error: `Arquivo tar inválido ou corrompido: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 400 }
    );
  }

  logActivity('backup', `Upload de backup recebido (${(bytesWritten / 1024 / 1024).toFixed(2)} MB)`, 'success', { metadata: { uploadId, sizeBytes: bytesWritten } });

  return NextResponse.json({ uploadId, sizeBytes: bytesWritten });
}
