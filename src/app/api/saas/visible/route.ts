/**
 * GET /api/saas/visible — whether the SaaS admin panel applies to THIS
 * install. Only the owner's control plane (deploy mode "native") provisions
 * clients; a client container (mode "coolify") must not even show the tab.
 *
 * Cheap by design: the Dock calls it once to decide whether to render the
 * "Clientes SaaS" item. Behind mc_auth (not in the proxy allowlist).
 */
import { NextResponse } from "next/server";
import { isContainerDeploy } from "@/lib/deploy-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ visible: !isContainerDeploy() });
}
