import { NextRequest } from "next/server";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const backend = req.nextUrl.searchParams.get("backend");

  if (!name || !backend) {
    return new Response("Missing name or backend", { status: 400 });
  }

  let cmd = "";
  let args: string[] = [];

  if (backend === "pm2") {
    cmd = "pm2";
    args = ["logs", name, "--raw", "--lines", "100"];
  } else if (backend === "systemd") {
    cmd = "journalctl";
    args = ["-u", name, "-f", "-n", "100"];
  } else if (backend === "docker") {
    cmd = "docker";
    args = ["logs", "-f", "--tail", "100", name];
  } else {
    return new Response("Unknown backend", { status: 400 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const sendEvent = (data: string) => {
        // We use JSON.stringify to safely encode newlines and special characters in SSE data payload
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(payload));
        } catch (e) {
          // Stream might be closed
        }
      };

      child.stdout.on("data", (chunk) => {
        sendEvent(chunk.toString());
      });

      child.stderr.on("data", (chunk) => {
        sendEvent(chunk.toString());
      });

      child.on("close", () => {
        try {
          controller.close();
        } catch (e) {}
      });

      child.on("error", (err) => {
        sendEvent(`[Log Error] ${err.message}`);
        try {
          controller.close();
        } catch (e) {}
      });

      // Cleanup when connection closes
      req.signal.addEventListener("abort", () => {
        child.kill();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
