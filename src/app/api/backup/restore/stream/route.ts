import { NextRequest } from "next/server";
import { readRestoreLiveStatus } from "@/lib/restore";
import { reconcile } from "@/lib/restore-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * SSE stream para o restore — espelho do /api/update/stream.
 *
 * Query params:
 *   logOffset:   byte offset no log para retomar (default 0)
 *   phaseOffset: byte offset no arquivo de phase events (default 0)
 *
 * Eventos emitidos:
 *   - snapshot: { liveStatus, logOffset, phaseOffset }
 *   - log:      { line, timestamp }
 *   - phase:    PhaseEventLine
 *   - offset:   { logOffset, phaseOffset }
 *   - complete: { success, error?, durationMs? }
 *   - stream-error: { message }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let logOffset = parseInt(url.searchParams.get("logOffset") || "0", 10);
  let phaseOffset = parseInt(url.searchParams.get("phaseOffset") || "0", 10);

  const live = readRestoreLiveStatus();
  if (!live) {
    return new Response(
      JSON.stringify({ error: "Nenhum restore ativo" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let pingInterval: NodeJS.Timeout | null = null;
        let tickInterval: NodeJS.Timeout | null = null;

        const safeClose = () => {
          if (closed) return;
          closed = true;
          if (pingInterval) clearInterval(pingInterval);
          if (tickInterval) clearInterval(tickInterval);
          try { controller.close(); } catch {}
        };

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            safeClose();
          }
        };

        const ping = () => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(":\n\n")); } catch { safeClose(); }
        };

        try {
          const initial = await reconcile(phaseOffset, logOffset);
          phaseOffset = initial.newPhaseOffset;
          logOffset = initial.newLogOffset;

          send("snapshot", { liveStatus: initial.liveStatus, logOffset, phaseOffset });

          for (const log of initial.newLogLines) send("log", log);
          for (const evt of initial.newPhaseEvents) {
            if (evt.phase && evt.status && evt.phase !== "start") send("phase", evt);
          }
          send("offset", { logOffset, phaseOffset });

          if (initial.liveStatus?.status === "complete" || initial.liveStatus?.status === "error") {
            const durationMs = initial.liveStatus.completedAt
              ? new Date(initial.liveStatus.completedAt).getTime() -
                new Date(initial.liveStatus.startedAt).getTime()
              : 0;
            send("complete", {
              success: initial.liveStatus.status === "complete",
              error: initial.liveStatus.error,
              durationMs,
              rolledBack: !!initial.liveStatus.rolledBack,
            });
            safeClose();
            return;
          }
        } catch (err) {
          send("stream-error", { message: err instanceof Error ? err.message : String(err) });
          safeClose();
          return;
        }

        tickInterval = setInterval(async () => {
          if (closed) return;
          try {
            const r = await reconcile(phaseOffset, logOffset);
            phaseOffset = r.newPhaseOffset;
            logOffset = r.newLogOffset;

            for (const log of r.newLogLines) send("log", log);
            for (const evt of r.newPhaseEvents) {
              if (evt.phase && evt.status && evt.phase !== "start") send("phase", evt);
            }

            if (r.newLogLines.length > 0 || r.newPhaseEvents.length > 0) {
              send("offset", { logOffset, phaseOffset });
            }

            if (!r.liveStatus) {
              send("complete", { success: true });
              safeClose();
              return;
            }

            if (r.justCompleted && r.liveStatus) {
              const durationMs = r.liveStatus.completedAt
                ? new Date(r.liveStatus.completedAt).getTime() -
                  new Date(r.liveStatus.startedAt).getTime()
                : 0;
              send("complete", {
                success: r.liveStatus.status === "complete",
                error: r.liveStatus.error,
                durationMs,
                rolledBack: !!r.liveStatus.rolledBack,
              });
              safeClose();
            } else if (
              r.liveStatus &&
              (r.liveStatus.status === "complete" || r.liveStatus.status === "error")
            ) {
              const durationMs = r.liveStatus.completedAt
                ? new Date(r.liveStatus.completedAt).getTime() -
                  new Date(r.liveStatus.startedAt).getTime()
                : 0;
              send("complete", {
                success: r.liveStatus.status === "complete",
                error: r.liveStatus.error,
                durationMs,
                rolledBack: !!r.liveStatus.rolledBack,
              });
              safeClose();
            }
          } catch (err) {
            send("stream-error", { message: err instanceof Error ? err.message : String(err) });
          }
        }, 500);

        pingInterval = setInterval(ping, 15000);
        req.signal.addEventListener("abort", safeClose);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }
  );
}
