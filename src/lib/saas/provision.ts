/**
 * Provisioning core — the single programmatic entry the admin API and the
 * (future) Mercado Pago worker both call. Ported from the imperative flow in
 * scripts/provision-client.mjs (main()), but resumable: every Coolify UUID is
 * written to the registry the moment it's obtained, so a retry on the same
 * slug skips steps already done.
 *
 * Only meaningful on the OWNER's control plane (deploy mode "native").
 */
import crypto from "crypto";
import { coolify } from "./coolify";
import { SAAS_REPO, SAAS_COMPOSE_LOCATION, SAAS_DEFAULT_BRANCH } from "./config";
import { clientFqdn, getBaseDomain } from "@/lib/client-identity";
import {
  getClient,
  updateClient,
  type SaasClient,
} from "./saas-clients-db";

function genPassword(bytes = 14): string {
  return crypto.randomBytes(bytes).toString("base64").replace(/[/+=]/g, "").slice(0, 18);
}

export interface ProvisionResult {
  ok: boolean;
  client: SaasClient | null;
  error?: string;
}

/**
 * Run the Coolify provisioning for an already-registered client (the caller
 * inserts the `pending` row first). Idempotent/resumable per slug.
 */
export async function provisionClient(slug: string): Promise<ProvisionResult> {
  let client = getClient(slug);
  if (!client) return { ok: false, client: null, error: `Cliente '${slug}' não existe no registry.` };

  try {
    client = updateClient(slug, { status: "provisioning", last_error: null })!;

    const serverUuid = await coolify.resolveServerUuid();

    // 1. Projeto (reaproveita se já criado)
    if (!client.coolify_project_uuid) {
      const projectUuid = await coolify.createProject(
        `AtlasDeck - ${client.name}`,
        `Instalação AtlasDeck do cliente ${client.name} (provisionada automaticamente).`,
      );
      client = updateClient(slug, { coolify_project_uuid: projectUuid })!;
    }

    // 2. Aplicação pública (compose, auto-deploy on push)
    if (!client.coolify_app_uuid) {
      const fqdn = client.fqdn || clientFqdn(slug, getBaseDomain());
      const appUuid = await coolify.createPublicApp({
        project_uuid: client.coolify_project_uuid,
        server_uuid: serverUuid,
        environment_name: "production",
        git_repository: SAAS_REPO,
        git_branch: SAAS_DEFAULT_BRANCH,
        build_pack: "dockercompose",
        docker_compose_location: SAAS_COMPOSE_LOCATION,
        name: `atlasdeck-${slug}`,
        description: `AtlasDeck - ${client.name}`,
        ports_exposes: "3000",
        is_auto_deploy_enabled: true,
        is_force_https_enabled: true,
        instant_deploy: false, // injeta envs antes do 1º build
        domains: `https://${fqdn}`,
      });
      client = updateClient(slug, { coolify_app_uuid: appUuid, fqdn })!;
    }

    const appUuid = client.coolify_app_uuid!;
    const fqdn = client.fqdn || clientFqdn(slug, getBaseDomain());

    // 2b. Mapeia o domínio ao serviço "app" do compose (sem isto o Coolify não
    // gera os labels do proxy e o domínio não roteia). HTTPS força TLS (o
    // cookie de auth do AtlasDeck é Secure em produção).
    await coolify.patchApp(appUuid, {
      docker_compose_domains: { app: { name: "app", domain: `https://${fqdn}` } },
    });

    // 3. Envs (gera segredos uma vez; reaproveita em retry)
    const adminPassword = client.admin_password || genPassword();
    const authSecret = client.auth_secret || crypto.randomBytes(32).toString("base64");
    await coolify.bulkEnvs(appUuid, [
      { key: "ATLASDECK_DEPLOY_MODE", value: "coolify", is_literal: true },
      { key: "ADMIN_PASSWORD", value: adminPassword, is_literal: true },
      { key: "AUTH_SECRET", value: authSecret, is_literal: true },
      { key: "OPENCLAW_DIR", value: "/root/.openclaw", is_literal: true },
      { key: "OPENCLAW_GATEWAY_PORT", value: "18789", is_literal: true },
      { key: "NEXT_PUBLIC_AGENT_NAME", value: client.name, is_literal: true },
      { key: "NEXT_PUBLIC_APP_TITLE", value: client.name, is_literal: true },
      { key: "ATLASDECK_CLIENT_SLUG", value: slug, is_literal: true },
      { key: "ATLASDECK_BASE_DOMAIN", value: getBaseDomain(), is_literal: true },
    ]);
    client = updateClient(slug, { admin_password: adminPassword, auth_secret: authSecret })!;

    // 4. Deploy
    const deploymentUuid = await coolify.triggerDeploy(appUuid);
    client = updateClient(slug, {
      coolify_deployment_uuid: deploymentUuid,
      status: "deploying",
    })!;

    return { ok: true, client };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = updateClient(slug, { status: "failed", last_error: message });
    return { ok: false, client: updated, error: message };
  }
}

/** Lifecycle hook (Fase B): stop a client's app (suspensão por inadimplência). */
export async function suspendClient(slug: string): Promise<ProvisionResult> {
  const client = getClient(slug);
  if (!client?.coolify_app_uuid) {
    return { ok: false, client, error: "Cliente sem app no Coolify." };
  }
  try {
    await coolify.stopApp(client.coolify_app_uuid);
    return { ok: true, client: updateClient(slug, { status: "suspended" }) };
  } catch (err) {
    return { ok: false, client, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Lifecycle hook (Fase B): start a suspended client's app (renovação). */
export async function reactivateClient(slug: string): Promise<ProvisionResult> {
  const client = getClient(slug);
  if (!client?.coolify_app_uuid) {
    return { ok: false, client, error: "Cliente sem app no Coolify." };
  }
  try {
    await coolify.startApp(client.coolify_app_uuid);
    return { ok: true, client: updateClient(slug, { status: "active" }) };
  } catch (err) {
    return { ok: false, client, error: err instanceof Error ? err.message : String(err) };
  }
}
