import { NextResponse } from "next/server";
import { readRestoreLiveStatus } from "@/lib/restore";
import { buildRestoreAudit } from "@/lib/restore-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backup/restore/audit
 *
 * Returns the post-mortem audit of the most recent restore session — used by
 * the UI to render the detailed "conference" report after success or failure.
 * Reads from `data/restore-live-status.json` (still on disk after the script
 * finishes) and the textual log, so the report survives PM2 restart.
 */
export async function GET() {
  const status = readRestoreLiveStatus();
  if (!status) {
    return NextResponse.json(
      { error: "Nenhum restore para auditar" },
      { status: 404 }
    );
  }
  const audit = buildRestoreAudit(status);
  return NextResponse.json(audit);
}
