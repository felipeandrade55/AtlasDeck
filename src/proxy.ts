import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasValidServiceTokenEdge } from "@/lib/openclaw-auth-edge";

// Routes that never require authentication
const PUBLIC_ROUTES = new Set(["/login"]);

// Public route prefixes (page routes without auth — e.g. /book/<token>)
const PUBLIC_ROUTE_PREFIXES = ["/book/"];

// API routes that are always public (auth endpoints + health check + public booking)
// VPS agent endpoints are public at the middleware layer because they carry a
// per-host token (validated inside the route, which the edge middleware can't
// check), not the admin cookie:
//   - /api/vps/ingest  → agent metric uploads (route does getHostByToken)
//   - /api/vps/install → generic installer script (no secrets; token is
//                        generated on the VPS, so curl|bash works without a cookie)
// NOTE: keep this list precise — the management routes (/api/vps, /api/vps/[id],
// /api/vps/[id]/metrics) stay behind the admin cookie. /api/vps/agent.py is
// already excluded from the matcher (it contains a dot).
const PUBLIC_API_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/calendar/public/",
  "/api/vps/ingest",
  "/api/vps/install",
  // Orchestrator tool-call (delegate_to / decompose / list_squad …) is hit by
  // the atlasdeck-memory MCP server (OpenClaw → AtlasDeck) which has no admin
  // cookie. The route self-protects: it requires a valid service token
  // (gateway.auth.token) OR the admin cookie, validated in the Node handler.
  "/api/orchestrator/tool-call",
];

// API prefixes that may also be authenticated via service token (OpenClaw → AtlasDeck)
const SERVICE_TOKEN_API_PREFIXES = ["/api/calendar/"];

function isAuthenticated(request: NextRequest): boolean {
  const authCookie = request.cookies.get("mc_auth");
  if (authCookie && authCookie.value === process.env.AUTH_SECRET) return true;

  const { pathname } = request.nextUrl;
  if (SERVICE_TOKEN_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (hasValidServiceTokenEdge(request)) return true;
  }

  return false;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow public pages (login)
  if (PUBLIC_ROUTES.has(pathname)) {
    return NextResponse.next();
  }

  if (PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Always allow public API routes (auth + health + public calendar booking)
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Check authentication
  if (!isAuthenticated(request)) {
    // For API routes: return 401 JSON (not a redirect)
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Authentication required" },
        { status: 401 }
      );
    }

    // For page routes: redirect to login
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (with extension)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
