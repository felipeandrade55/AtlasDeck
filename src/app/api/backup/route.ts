import { NextRequest, NextResponse } from "next/server";
import {
  runBackup,
  deleteBackup,
  getBackupStats,
  readBackupConfig,
  writeBackupConfig,
} from "@/lib/backup";

// GET: List backups and stats
export async function GET() {
  try {
    const stats = getBackupStats();
    return NextResponse.json(stats);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/backup] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: Run backup now
export async function POST() {
  try {
    const result = await runBackup();
    if (!result.success) {
      return NextResponse.json(
        { error: "Backup failed", entry: result.entry, logPath: result.logPath },
        { status: 500 }
      );
    }
    return NextResponse.json({
      success: true,
      entry: result.entry,
      archivePath: result.archivePath,
      logPath: result.logPath,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/backup] POST error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE: Remove a backup by id
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }
    const ok = deleteBackup(id);
    if (!ok) {
      return NextResponse.json({ error: "Backup not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/backup] DELETE error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
