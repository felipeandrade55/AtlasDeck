/**
 * Per-client SaaS API (owner only).
 *
 *   GET   /api/saas/clients/<slug>  → detalhe (com credenciais, p/ o dono)
 *   PATCH /api/saas/clients/<slug>  → ações: resend | suspend | reactivate | reprovision
 */
import { NextRequest, NextResponse } from "next/server";
import { isContainerDeploy } from "@/lib/deploy-mode";
import { getClient } from "@/lib/saas/saas-clients-db";
import {
  provisionClient,
  suspendClient,
  reactivateClient,
} from "@/lib/saas/provision";
import { deliverCredentials } from "@/lib/saas/credentials";
import { triggerProvisionCheck } from "@/lib/saas/provision-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

function ownerOnlyGuard(): NextResponse | null {
  if (isContainerDeploy()) {
    return NextResponse.json(
      { error: "Disponível apenas na instância do dono (modo nativo)." },
      { status: 403 },
    );
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = ownerOnlyGuard();
  if (guard) return guard;
  const { slug } = await params;
  const client = getClient(slug);
  if (!client) return NextResponse.json({ error: "Cliente não encontrado." }, { status: 404 });
  return NextResponse.json({ client });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = ownerOnlyGuard();
  if (guard) return guard;
  const { slug } = await params;
  if (!getClient(slug)) return NextResponse.json({ error: "Cliente não encontrado." }, { status: 404 });

  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  switch (body.action) {
    case "resend": {
      const r = await deliverCredentials(slug);
      return NextResponse.json(r, { status: r.ok ? 200 : 502 });
    }
    case "suspend": {
      const r = await suspendClient(slug);
      return NextResponse.json(r, { status: r.ok ? 200 : 502 });
    }
    case "reactivate": {
      const r = await reactivateClient(slug);
      return NextResponse.json(r, { status: r.ok ? 200 : 502 });
    }
    case "reprovision": {
      void provisionClient(slug)
        .then(() => triggerProvisionCheck())
        .catch((err) => console.warn(`[saas] reprovision(${slug}) falhou:`, err));
      return NextResponse.json({ ok: true, client: getClient(slug) }, { status: 202 });
    }
    default:
      return NextResponse.json(
        { error: "Ação inválida (resend | suspend | reactivate | reprovision)." },
        { status: 400 },
      );
  }
}
