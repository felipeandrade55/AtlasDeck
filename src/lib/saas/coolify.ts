/**
 * Thin typed client for the Coolify API — the only piece that talks HTTP to
 * Coolify. Ported from scripts/provision-client.mjs so the CLI and the
 * control-plane share one shape. Every call throws on non-2xx with a sliced
 * body so the orchestrator can log/persist the failure.
 */
import { getCoolifyConfig, type CoolifyConfig } from "./config";

export interface CoolifyServer {
  uuid: string;
  name?: string;
  is_coolify_host?: boolean;
}

export interface CoolifyApp {
  uuid?: string;
  application_uuid?: string;
  id?: string | number;
  fqdn?: string;
  status?: string;
}

export interface CoolifyDeployment {
  status?: string; // queued | in_progress | finished | failed | cancelled-by-force
  deployment_uuid?: string;
  finished_at?: string | null;
}

async function rawApi<T>(
  cfg: CoolifyConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Coolify ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json as T;
}

/** Resolve config or throw a clear, actionable error. */
function requireConfig(): CoolifyConfig {
  const cfg = getCoolifyConfig();
  if (!cfg) {
    throw new Error(
      "Coolify não configurado: defina COOLIFY_URL e COOLIFY_TOKEN (env ou data/saas-config.json).",
    );
  }
  return cfg;
}

export const coolify = {
  configured(): boolean {
    return getCoolifyConfig() !== null;
  },

  async listServers(): Promise<CoolifyServer[]> {
    return rawApi<CoolifyServer[]>(requireConfig(), "GET", "/servers");
  },

  /** UUID of the Coolify host server (or the first server if no host flag). */
  async resolveServerUuid(): Promise<string> {
    const cfg = requireConfig();
    if (cfg.serverUuid) return cfg.serverUuid;
    const servers = await rawApi<CoolifyServer[]>(cfg, "GET", "/servers");
    const host = servers.find((s) => s.is_coolify_host) || servers[0];
    if (!host?.uuid) throw new Error("Nenhum servidor encontrado no Coolify.");
    return host.uuid;
  },

  async createProject(name: string, description: string): Promise<string> {
    const p = await rawApi<{ uuid?: string; id?: string }>(requireConfig(), "POST", "/projects", {
      name,
      description,
    });
    const uuid = p.uuid || p.id;
    if (!uuid) throw new Error(`Coolify não retornou uuid do projeto: ${JSON.stringify(p)}`);
    return uuid;
  },

  async createPublicApp(body: Record<string, unknown>): Promise<string> {
    const app = await rawApi<CoolifyApp>(requireConfig(), "POST", "/applications/public", body);
    const uuid = app.uuid || app.application_uuid || (app.id != null ? String(app.id) : undefined);
    if (!uuid) throw new Error(`Coolify não retornou uuid da aplicação: ${JSON.stringify(app)}`);
    return uuid;
  },

  async getApplication(appUuid: string): Promise<CoolifyApp> {
    return rawApi<CoolifyApp>(requireConfig(), "GET", `/applications/${appUuid}`);
  },

  async patchApp(appUuid: string, patch: Record<string, unknown>): Promise<void> {
    await rawApi(requireConfig(), "PATCH", `/applications/${appUuid}`, patch);
  },

  async bulkEnvs(appUuid: string, envs: Array<{ key: string; value: string; is_literal?: boolean }>): Promise<void> {
    const cfg = requireConfig();
    try {
      await rawApi(cfg, "PATCH", `/applications/${appUuid}/envs/bulk`, { data: envs });
    } catch {
      // Fallback: cria uma a uma se o bulk não for aceito por esta versão.
      for (const env of envs) {
        await rawApi(cfg, "POST", `/applications/${appUuid}/envs`, env).catch(() => {});
      }
    }
  },

  async triggerDeploy(appUuid: string): Promise<string | null> {
    const r = await rawApi<{ deployments?: Array<{ deployment_uuid?: string }> }>(
      requireConfig(),
      "GET",
      `/deploy?uuid=${appUuid}&force=false`,
    );
    return r.deployments?.[0]?.deployment_uuid ?? null;
  },

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    return rawApi<CoolifyDeployment>(requireConfig(), "GET", `/deployments/${deploymentUuid}`);
  },

  /** Stop (suspend) / start (reactivate) a client app — lifecycle hooks. */
  async stopApp(appUuid: string): Promise<void> {
    await rawApi(requireConfig(), "GET", `/applications/${appUuid}/stop`);
  },
  async startApp(appUuid: string): Promise<void> {
    await rawApi(requireConfig(), "GET", `/applications/${appUuid}/start`);
  },
};
