/**
 * Install OpenClaw — streams progress as SSE so the welcome wizard can
 * render a live mini-terminal. The install lib does the actual work
 * (npm -g first, EACCES fallback to ~/.openclaw-bin).
 */
import { installOpenClaw, type ProgressFn } from "@/lib/openclaw-installer";
import { setSettings } from "@/lib/memory-db";

export const dynamic = "force-dynamic";

function sseLine(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(sseLine(event, data)));
        } catch {
          // controller may already be closed when client aborts
        }
      };

      const onProgress: ProgressFn = (kind, line) => {
        send("log", { kind, line });
      };

      try {
        const result = await installOpenClaw(onProgress, { force });
        setSettings({ setup_step: "ai" });
        send("done", {
          binPath: result.binPath,
          version: result.version,
          installedTo: result.installedTo,
        });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
