/**
 * SaaS client registry API (control-plane / owner only).
 *
 *   GET  /api/saas/clients  → lista (sem segredos)
 *   POST /api/saas/clients  → cria + provisiona um cliente novo
 *
 * Protegido pelo cookie mc_auth automaticamente (não está na allowlist do
 * proxy.ts). Disponível só no app do dono (deploy mode "native").
 */
import { NextRequest, NextResponse } from "next/server";
import { isContainerDeploy } from "@/lib/deploy-mode";
import { slugify, clientFqdn, getBaseDomain } from "@/lib/client-identity";
import { coolify } from "@/lib/saas/coolify";
import {
  createClient,
  getClient,
  listClients,
  toPublicClient,
} from "@/lib/saas/saas-clients-db";
import { provisionClient } from "@/lib/saas/provision";
import { triggerProvisionCheck } from "@/lib/saas/provision-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ownerOnlyGuard(): NextResponse | null {
  if (isContainerDeploy()) {
    return NextResponse.json(
      { error: "Disponível apenas na instância do dono (modo nativo)." },
      { status: 403 },
    );
  }
  return null;
}

export async function GET() {
  const guard = ownerOnlyGuard();
  if (guard) return guard;
  return NextResponse.json({
    coolifyConfigured: coolify.configured(),
    baseDomain: getBaseDomain(),
    clients: listClients().map(toPublicClient),
  });
}

export async function POST(req: NextRequest) {
  const guard = ownerOnlyGuard();
  if (guard) return guard;

  let body: { name?: string; slug?: string; email?: string; plan?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Informe o nome do cliente." }, { status: 400 });

  const slug = slugify(body.slug || name);
  if (!slug) return NextResponse.json({ error: "Slug inválido." }, { status: 400 });

  if (!coolify.configured()) {
    return NextResponse.json(
      { error: "Coolify não configurado (COOLIFY_URL / COOLIFY_TOKEN)." },
      { status: 400 },
    );
  }
  if (getClient(slug)) {
    return NextResponse.json({ error: `Já existe um cliente com slug '${slug}'.` }, { status: 409 });
  }

  const fqdn = clientFqdn(slug, getBaseDomain());
  const client = createClient({
    slug,
    name,
    contact_email: (body.email ?? "").trim() || null,
    plan: (body.plan ?? "").trim() || null,
    fqdn,
    source: "admin",
  });

  // Provisiona em background; o scheduler acompanha o deploy até healthy.
  void provisionClient(slug)
    .then(() => triggerProvisionCheck())
    .catch((err) => console.warn(`[saas] provisionClient(${slug}) falhou:`, err));

  // Rota do dono: devolve o registro completo (com a senha gerada) pro painel.
  return NextResponse.json({ client }, { status: 201 });
}
