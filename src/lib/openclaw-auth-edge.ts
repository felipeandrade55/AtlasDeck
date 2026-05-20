/**
 * Edge-safe variant of service token validation. Only checks against the env var
 * `OPENCLAW_SERVICE_TOKEN` so it can run inside Next.js middleware (no fs/path).
 *
 * The full validator (with openclaw.json fallback) lives in `openclaw-auth.ts`
 * and is used by Node route handlers.
 */

import type { NextRequest } from "next/server";

const SERVICE_HEADER = "x-openclaw-token";

export function hasValidServiceTokenEdge(request: NextRequest): boolean {
  const header = request.headers.get(SERVICE_HEADER);
  if (!header) return false;
  const expected = process.env.OPENCLAW_SERVICE_TOKEN;
  if (!expected) return false;
  return header === expected;
}
