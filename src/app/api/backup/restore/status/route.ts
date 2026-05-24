import { NextResponse } from "next/server";
import { getActiveRestore } from "@/lib/restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backup/restore/status
 *
 * Returns { active, status } so the RestorePanel can reattach to an in-flight
 * restore after a page reload (e.g. after the app restarted as part of the
 * restore flow itself).
 */
export async function GET() {
  const status = getActiveRestore();
  return NextResponse.json({
    active: !!status && status.status === "running",
    status,
  });
}
