/**
 * GET /api/chat/ws-debug
 *
 * Walks several WebSocket-upgrade attempts against the OpenClaw Gateway
 * and surfaces the raw HTTP response from each, so we can diagnose why
 * the chat runner keeps falling back to the CLI. Without this endpoint
 * we only see "handshake timeout" / "closed XYZ" with no hint on what
 * the gateway actually expected (auth method, path, origin, ...).
 *
 * For each candidate we:
 *  - open a raw TCP socket to the gateway port
 *  - send a WebSocket upgrade request manually
 *  - capture the full status line + response headers (+ short body)
 *  - close immediately
 *
 * The endpoint is GET-only and read-only — safe to expose behind the
 * existing /api/* auth middleware.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import net from "net";
import { getOpenClawGatewayInfo } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProbeAttempt {
  label: string;
  path: string;
  authMode: "header" | "query" | "none";
  origin: string | null;
}

interface ProbeResult extends ProbeAttempt {
  statusLine: string | null;
  headers: Record<string, string>;
  body: string;
  error: string | null;
  durationMs: number;
}

function buildAttempts(token: string | null): ProbeAttempt[] {
  const paths = ["/", "/ws", "/api/ws", "/gateway/ws", "/chat"];
  const origins: Array<string | null> = [
    null,
    "http://127.0.0.1:18789",
    "http://localhost:18789",
  ];

  const out: ProbeAttempt[] = [];
  for (const path of paths) {
    for (const origin of origins) {
      if (token) {
        out.push({
          label: `header bearer · path=${path} · origin=${origin ?? "(none)"}`,
          path,
          authMode: "header",
          origin,
        });
      }
      out.push({
        label: `query token · path=${path} · origin=${origin ?? "(none)"}`,
        path,
        authMode: token ? "query" : "none",
        origin,
      });
    }
  }
  return out;
}

function buildRequest(
  host: string,
  port: number,
  attempt: ProbeAttempt,
  token: string | null,
  key: string,
): string {
  let fullPath = attempt.path;
  if (attempt.authMode === "query" && token) {
    fullPath += `?token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}&auth=${encodeURIComponent(token)}`;
  }
  const lines: string[] = [
    `GET ${fullPath} HTTP/1.1`,
    `Host: ${host}:${port}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: 13`,
  ];
  if (attempt.authMode === "header" && token) {
    lines.push(`Authorization: Bearer ${token}`);
  }
  if (attempt.origin) {
    lines.push(`Origin: ${attempt.origin}`);
  }
  lines.push("");
  lines.push("");
  return lines.join("\r\n");
}

function probe(
  host: string,
  port: number,
  attempt: ProbeAttempt,
  token: string | null,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const key = randomBytes(16).toString("base64");
    const req = buildRequest(host, port, attempt, token, key);
    const socket = net.connect(port, host);
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      const lines = raw.split(/\r?\n/);
      const statusLine = lines[0] || null;
      const headers: Record<string, string> = {};
      let i = 1;
      for (; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === "") {
          i += 1;
          break;
        }
        const sep = line.indexOf(":");
        if (sep > 0) {
          const k = line.slice(0, sep).trim().toLowerCase();
          const v = line.slice(sep + 1).trim();
          headers[k] = v;
        }
      }
      const body = lines.slice(i).join("\n").slice(0, 240);
      try {
        socket.destroy();
      } catch {}
      resolve({
        ...attempt,
        statusLine,
        headers,
        body,
        error,
        durationMs: Date.now() - started,
      });
    };

    socket.setTimeout(1500);
    socket.on("connect", () => {
      try {
        socket.write(req);
      } catch (err) {
        finish((err as Error).message);
      }
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      // Wait briefly for more headers, then settle
      setTimeout(() => finish(null), 100);
    });
    socket.on("timeout", () => finish("socket timeout 1.5s"));
    socket.on("error", (err) => finish(err.message));
    socket.on("close", () => {
      if (chunks.length === 0) finish("closed without response");
    });
  });
}

export async function GET() {
  const info = getOpenClawGatewayInfo();
  const url = new URL(info.url);
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port) || info.port;

  const attempts = buildAttempts(info.token || null);
  const results: ProbeResult[] = [];

  // Run sequentially so the gateway doesn't see a thundering herd
  for (const attempt of attempts) {
    const res = await probe(host, port, attempt, info.token || null);
    results.push(res);
    // Short-circuit if we hit a 101 — that's the success and no need to keep probing
    if (res.statusLine?.startsWith("HTTP/1.1 101")) break;
  }

  const winner = results.find((r) => r.statusLine?.startsWith("HTTP/1.1 101"));

  return NextResponse.json({
    gateway: {
      host,
      port,
      url: info.url,
      hasToken: !!info.token,
      tokenPreview: info.token
        ? `${info.token.slice(0, 4)}…${info.token.slice(-4)}`
        : null,
    },
    winner: winner
      ? {
          path: winner.path,
          authMode: winner.authMode,
          origin: winner.origin,
        }
      : null,
    summary: results.map((r) => ({
      label: r.label,
      statusLine: r.statusLine,
      durationMs: r.durationMs,
      error: r.error,
    })),
    full: results,
  });
}
