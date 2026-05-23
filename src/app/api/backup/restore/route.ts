import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import {
  previewRestore,
  restoreBackup,
  readBackupConfig,
  readManifest,
} from "@/lib/backup";
import { logActivity } from "@/lib/activities-db";

function resolveArchive(
  body: { entryId?: string; archivePath?: string }
): { archivePath: string; entryId?: string } | { error: string; status: number } {
  if (body.archivePath) {
    const abs = path.resolve(body.archivePath);
    if (!fs.existsSync(abs)) {
      return { error: `archivePath not found: ${abs}`, status: 404 };
    }
    return { archivePath: abs };
  }

  if (!body.entryId) {
    return { error: "Provide entryId or archivePath", status: 400 };
  }

  const config = readBackupConfig();
  const dest = path.resolve(config.destination);
  const manifest = readManifest(dest);
  const entry = manifest.entries.find((e) => e.id === body.entryId);
  if (!entry) {
    return { error: `Backup entry not found: ${body.entryId}`, status: 404 };
  }
  const archivePath = path.join(dest, entry.filename);
  if (!fs.existsSync(archivePath)) {
    return { error: `Archive file missing on disk: ${archivePath}`, status: 410 };
  }
  return { archivePath, entryId: body.entryId };
}

// GET ?entryId=... or ?archivePath=...
// Returns preview (mappings, origin, platform check) without extracting.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const entryId = searchParams.get("entryId") || undefined;
    const archivePath = searchParams.get("archivePath") || undefined;

    const resolved = resolveArchive({ entryId, archivePath });
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const preview = await previewRestore(resolved.archivePath);
    return NextResponse.json({ preview });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/backup/restore] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST { entryId?, archivePath?, dryRun?, overwrite?, keepStaging? }
// Runs the restore. With dryRun=true, returns the plan without touching disk.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const resolved = resolveArchive(body);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const dryRun = body.dryRun !== false ? !!body.dryRun : false;
    const overwrite = body.overwrite !== false; // default true
    const keepStaging = !!body.keepStaging;

    const result = await restoreBackup(resolved.archivePath, {
      dryRun,
      overwrite,
      keepStaging,
    });

    if (!dryRun) {
      try {
        logActivity(
          "backup",
          `Restore: ${result.restored.length} arquivo(s) restaurado(s)${result.skipped.length ? `, ${result.skipped.length} pulado(s)` : ""}`,
          "success",
          {
            duration_ms: result.durationMs,
            metadata: {
              archivePath: resolved.archivePath,
              entryId: resolved.entryId,
              restoredCount: result.restored.length,
              skippedCount: result.skipped.length,
            },
          }
        );
      } catch {}
    }

    return NextResponse.json({
      success: result.success,
      dryRun,
      preview: result.preview,
      restoredCount: result.restored.length,
      skippedCount: result.skipped.length,
      totalBytesRestored: result.restored.reduce((s, r) => s + r.bytes, 0),
      durationMs: result.durationMs,
      // Limit detail payload to avoid huge responses on full restores
      restoredSample: result.restored.slice(0, 50),
      skippedSample: result.skipped.slice(0, 50),
      staging: result.staging,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/backup/restore] POST error:", msg);
    try {
      logActivity("backup", `Restore falhou: ${msg}`, "error");
    } catch {}
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
