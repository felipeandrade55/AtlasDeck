#!/usr/bin/env node
/**
 * provision-client.mjs — provisiona uma instalação do AtlasDeck para um cliente
 * novo no Coolify, como UM projeto dedicado (padrão SaaS).
 *
 * O que faz (idempotente no melhor esforço):
 *   1. Cria um projeto no Coolify.
 *   2. Cria a aplicação a partir do repositório público (build pack: dockercompose,
 *      lendo docker-compose.coolify.yml) com auto-deploy on push habilitado.
 *   3. Injeta as variáveis de ambiente (ADMIN_PASSWORD e AUTH_SECRET aleatórios,
 *      ATLASDECK_DEPLOY_MODE=coolify, branding).
 *   4. Dispara o primeiro deploy.
 *   5. Imprime a URL e a senha de admin gerada.
 *
 * Uso:
 *   COOLIFY_URL=http://IP:8000 COOLIFY_TOKEN=xxxx \
 *     node scripts/provision-client.mjs --name "Cliente XYZ" --slug cliente-xyz \
 *       [--domain app.cliente.com] [--branch main] [--no-deploy]
 *
 * Requer Node 18+ (fetch global). Veja docs/DEPLOY-COOLIFY.md.
 */
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config / argumentos
// ---------------------------------------------------------------------------
const REPO = "https://github.com/felipeandrade55/AtlasDeck.git";
const COMPOSE_LOCATION = "/docker-compose.coolify.yml";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const COOLIFY_URL = (process.env.COOLIFY_URL || args.url || "").replace(/\/$/, "");
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || args.token;
const NAME = args.name || args.slug;
const SLUG = (args.slug || args.name || "")
  .toString()
  .toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-+|-+$/g, "");
const BRANCH = args.branch || "main";
const DOMAIN = args.domain || null; // se ausente, Coolify auto-gera (sslip.io / wildcard)
const SERVER_UUID = process.env.COOLIFY_SERVER_UUID || args.server || null;
const DO_DEPLOY = !args["no-deploy"];

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!COOLIFY_URL || !COOLIFY_TOKEN) die("Defina COOLIFY_URL e COOLIFY_TOKEN.");
if (!SLUG) die("Informe --name ou --slug do cliente.");

// ---------------------------------------------------------------------------
// Cliente da API
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(`${COOLIFY_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${COOLIFY_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

function genSecret(bytes) {
  return crypto.randomBytes(bytes).toString("base64").replace(/[/+=]/g, "").slice(0, Math.ceil(bytes * 1.3));
}

// ---------------------------------------------------------------------------
// Fluxo
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n▸ Provisionando cliente "${NAME}" (slug: ${SLUG}) no Coolify ${COOLIFY_URL}\n`);

  // 0. Descobre o servidor (usa o host do Coolify se não informado).
  let serverUuid = SERVER_UUID;
  if (!serverUuid) {
    const servers = await api("GET", "/servers");
    const host = servers.find((s) => s.is_coolify_host) || servers[0];
    if (!host) die("Nenhum servidor encontrado no Coolify.");
    serverUuid = host.uuid;
    console.log(`  servidor: ${host.name} (${serverUuid})`);
  }

  // 1. Cria o projeto.
  const project = await api("POST", "/projects", {
    name: `AtlasDeck - ${NAME}`,
    description: `Instalacao AtlasDeck do cliente ${NAME} (provisionada automaticamente).`,
  });
  const projectUuid = project.uuid || project.id;
  console.log(`  ✓ projeto criado: ${projectUuid}`);

  // 2. Cria a aplicação (compose público, auto-deploy on push).
  const appBody = {
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    environment_name: "production",
    git_repository: REPO,
    git_branch: BRANCH,
    build_pack: "dockercompose",
    docker_compose_location: COMPOSE_LOCATION,
    name: `atlasdeck-${SLUG}`,
    description: `AtlasDeck - ${NAME}`,
    ports_exposes: "3000",
    is_auto_deploy_enabled: true,
    is_force_https_enabled: true,
    instant_deploy: false, // injeta env vars antes do 1º build
  };
  if (DOMAIN) appBody.domains = `https://${DOMAIN}`;
  else appBody.autogenerate_domain = true;

  const app = await api("POST", "/applications/public", appBody);
  const appUuid = app.uuid || app.application_uuid || app.id;
  if (!appUuid) die(`Não consegui obter o UUID da aplicação. Resposta: ${JSON.stringify(app)}`);
  console.log(`  ✓ aplicação criada: ${appUuid}`);

  // 3. Variáveis de ambiente.
  const adminPassword = genSecret(14);
  const authSecret = crypto.randomBytes(32).toString("base64");
  const envs = [
    { key: "ATLASDECK_DEPLOY_MODE", value: "coolify", is_literal: true },
    { key: "ADMIN_PASSWORD", value: adminPassword, is_literal: true },
    { key: "AUTH_SECRET", value: authSecret, is_literal: true },
    { key: "OPENCLAW_DIR", value: "/root/.openclaw", is_literal: true },
    { key: "OPENCLAW_GATEWAY_PORT", value: "18789", is_literal: true },
    { key: "NEXT_PUBLIC_AGENT_NAME", value: NAME, is_literal: true },
    { key: "NEXT_PUBLIC_APP_TITLE", value: NAME, is_literal: true },
  ];
  try {
    await api("PATCH", `/applications/${appUuid}/envs/bulk`, { data: envs });
    console.log(`  ✓ ${envs.length} variáveis de ambiente injetadas`);
  } catch (e) {
    // Fallback: cria uma a uma se o bulk não for aceito.
    console.log(`  ! bulk de envs falhou (${e.message}); tentando uma a uma…`);
    for (const env of envs) {
      await api("POST", `/applications/${appUuid}/envs`, env).catch((err) =>
        console.log(`    ! env ${env.key}: ${err.message}`),
      );
    }
  }

  // 4. Deploy.
  if (DO_DEPLOY) {
    await api("GET", `/deploy?uuid=${appUuid}`);
    console.log(`  ✓ deploy disparado`);
  } else {
    console.log(`  · deploy NÃO disparado (--no-deploy). Dispare na UI quando quiser.`);
  }

  // 5. Resumo.
  let fqdn = DOMAIN;
  try {
    const fresh = await api("GET", `/applications/${appUuid}`);
    fqdn = (fresh.fqdn || fresh.domains || fqdn || "").toString().split(",")[0];
  } catch {
    /* ignore */
  }

  console.log(`\n✅ Cliente provisionado.\n`);
  console.log(`   Projeto:   AtlasDeck - ${NAME} (${projectUuid})`);
  console.log(`   App UUID:  ${appUuid}`);
  console.log(`   URL:       ${fqdn || "(veja na UI; Coolify gera o domínio)"}`);
  console.log(`   Login:     admin via ADMIN_PASSWORD`);
  console.log(`   Senha:     ${adminPassword}`);
  console.log(`\n   Guarde a senha — ela também está nas envs do app no Coolify.`);
  console.log(`   O wizard de onboarding (OpenClaw + IA + Telegram) roda no 1º acesso.\n`);
}

main().catch((e) => die(e.message));
