/**
 * GET  /api/agents/memory-ingest?agentId=<id>
 *        → preview: lists sessions, sizes, current DB state
 *
 * POST /api/agents/memory-ingest
 *        body: { agentId: string; dryRun?: boolean; backup?: boolean }
 *        → streams Server-Sent Events of progress (start, parsed, inserted, error, done)
 *          Single connection per ingest run. Client should accumulate counters
 *          and show progress bar; the "done" event has the final summary.
 *
 * Why SSE: ingesting 44+ sessions sequentially can take 10-30 seconds total
 * (filesystem reads + sqlite UPSERTs). A buffered JSON response would freeze
 * the UI; SSE gives per-file updates the user can watch.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  listSessionFiles,
  checkDbState,
  backupMemoryDb,
  ingestSessions,
} from "@/lib/session-ingest";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const agentId = (req.nextUrl.searchParams.get("agentId") || "").trim();
  if (!agentId) {
    return NextResponse.json({ error: "agentId obrigatório" }, { status: 400 });
  }
  const files = listSessionFiles(agentId);
  const db = checkDbState();
  const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
  const latest = files[0]?.mtimeMs ? new Date(files[0].mtimeMs).toISOString() : null;
  const oldest = files[files.length - 1]?.mtimeMs ? new Date(files[files.length - 1].mtimeMs).toISOString() : null;
  return NextResponse.json(
    {
      agentId,
      sessions: {
        count: files.length,
        totalBytes,
        latest,
        oldest,
        sample: files.slice(0, 5).map((f) => ({
          sessionId: f.sessionId,
          bytes: f.bytes,
          modified: new Date(f.mtimeMs).toISOString(),
        })),
      },
      memoryDb: db,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  let body: { agentId?: string; dryRun?: boolean; backup?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  const agentId = (body.agentId || "").trim();
  if (!agentId) {
    return NextResponse.json({ error: "agentId obrigatório" }, { status: 400 });
  }

  // Optional backup of agent_memory.db before mutation (default: true unless explicitly false)
  const wantsBackup = body.backup !== false && !body.dryRun;
  let backupPath: string | undefined;
  if (wantsBackup) {
    const r = backupMemoryDb();
    if (r.ok) backupPath = r.backupPath;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };

      send({ event: "init", agentId, dryRun: !!body.dryRun, backupPath });

      try {
        for (const ev of ingestSessions(agentId, { dryRun: !!body.dryRun })) {
          send(ev);
          if (ev.type === "done") {
            try {
              logActivity(
                "agent",
                `Session-ingest concluído (${agentId}): +${ev.summary?.inserted ?? 0} memórias importadas`,
                ev.summary?.errors ? "warning" : "success",
                {
                  agent: agentId,
                  metadata: { ...ev.summary, backupPath, dryRun: !!body.dryRun },
                },
              );
            } catch {}
          }
        }
      } catch (e) {
        send({ type: "error", detail: e instanceof Error ? e.message : String(e) });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
