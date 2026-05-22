/**
 * GET  /api/chat/import/openclaw  -> list available OpenClaw sessions
 * POST /api/chat/import/openclaw  -> import (all, or filtered by sessionIds)
 *
 * Body: { sessionIds?: string[]; force?: boolean }
 *   - sessionIds : import only those, otherwise all sessions
 *   - force      : rebuild thread messages from scratch (drops + reimports)
 *
 * The route is idempotent: re-running it skips files whose mtime + line
 * count match the previously imported snapshot.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  importOpenClawSessions,
  listAvailableSessions,
} from "@/lib/openclaw-sessions-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = listAvailableSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

interface ImportBody {
  sessionIds?: string[];
  force?: boolean;
}

export async function POST(req: NextRequest) {
  let body: ImportBody = {};
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    // empty body is fine — means "import all"
  }

  try {
    const summary = importOpenClawSessions({
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : undefined,
      force: body.force === true,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
