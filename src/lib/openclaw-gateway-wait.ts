/**
 * Wait until the OpenClaw gateway is listening on its TCP port.
 *
 * Used after a restart to confirm the daemon is back up before
 * declaring an MCP activation "ready". A plain TCP connect is
 * enough — we don't need to complete the WebSocket handshake or
 * authenticate, just see that something is accepting connections
 * on the port.
 */
import { createConnection } from "net";
import { getOpenClawGatewayInfo } from "@/lib/openclaw-config";

export interface WaitResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  port: number;
  lastError: string | null;
}

function probePort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("probe-timeout")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

export async function waitForGateway(
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    host?: string;
  } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 400;
  const host = opts.host ?? "127.0.0.1";
  const { port } = getOpenClawGatewayInfo();

  const start = Date.now();
  let attempts = 0;
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    attempts++;
    try {
      await probePort(host, port, Math.min(intervalMs * 2, 2000));
      return {
        ready: true,
        attempts,
        elapsedMs: Date.now() - start,
        port,
        lastError: null,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - start,
    port,
    lastError,
  };
}
