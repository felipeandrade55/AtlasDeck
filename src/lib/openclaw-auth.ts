/**
 * Service-to-service auth between OpenClaw and AtlasDeck.
 *
 * Reads `gateway.auth.token` from $OPENCLAW_DIR/openclaw.json (same source the cron
 * route already uses) and exposes a header-based validator. Used by middleware to let
 * OpenClaw skills hit /api/calendar/* without the user cookie.
 */

import fs from "fs";
import path from "path";
import type { NextRequest } from "next/server";

const SERVICE_HEADER = "x-openclaw-token";

let cachedToken: string | null | undefined = undefined;
let cachedAtMs = 0;
const CACHE_TTL_MS = 30_000;

function readTokenFromConfig(): string | null {
  try {
    const dir = process.env.OPENCLAW_DIR || "/root/.openclaw";
    const configPath = path.join(dir, "openclaw.json");
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    return config.gateway?.auth?.token || null;
  } catch {
    return null;
  }
}

export function getServiceToken(): string | null {
  const now = Date.now();
  if (cachedToken !== undefined && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedToken;
  }
  cachedToken = process.env.OPENCLAW_SERVICE_TOKEN || readTokenFromConfig();
  cachedAtMs = now;
  return cachedToken;
}

export function hasValidServiceToken(request: NextRequest): boolean {
  const header = request.headers.get(SERVICE_HEADER);
  if (!header) return false;
  const expected = getServiceToken();
  if (!expected) return false;
  return header === expected;
}

export const SERVICE_TOKEN_HEADER = SERVICE_HEADER;
