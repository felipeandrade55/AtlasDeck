/**
 * Auth for memory routes called from inside the OpenClaw gateway (bridge
 * plugin, MCP server). Public at the edge (no admin cookie there);
 * accepted with the gateway service token or the admin cookie.
 */
import type { NextRequest } from "next/server";
import { hasValidServiceToken } from "@/lib/openclaw-auth";

export function isMemoryApiAuthorized(request: NextRequest): boolean {
  if (hasValidServiceToken(request)) return true;
  const cookie = request.cookies.get("mc_auth");
  return Boolean(cookie && process.env.AUTH_SECRET && cookie.value === process.env.AUTH_SECRET);
}
