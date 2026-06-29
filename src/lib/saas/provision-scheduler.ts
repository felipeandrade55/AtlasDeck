/**
 * Provisioning worker — drives clients from "deploying" to "active".
 *
 * Coolify builds asynchronously, so the admin POST returns once the deploy is
 * triggered and THIS in-process scheduler (same pattern as update-scheduler.ts)
 * polls each deploying client per tick: healthy → active + deliver credentials;
 * failed → mark failed + notify; stuck too long → fail with a timeout.
 *
 * Runs only on the OWNER's control plane (deploy mode "native").
 */
import { isContainerDeploy } from "@/lib/deploy-mode";
import { listClients, updateClient, type SaasClient } from "./saas-clients-db";
import { checkDeployPhase } from "./deploy-poll";
import { deliverCredentials } from "./credentials";
import { addNotification } from "@/lib/notifications";
import { logActivity } from "@/lib/activities-db";

const TICK_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 20 * 60_000; // build costuma ~10min; 20 é folga

let started = false;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

function ageMs(sqliteTs: string | null): number {
  if (!sqliteTs) return 0;
  const ms = Date.parse(`${sqliteTs.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? Date.now() - ms : 0;
}

async function advanceClient(client: SaasClient): Promise<void> {
  const phase = await checkDeployPhase(client.coolify_app_uuid, client.coolify_deployment_uuid);

  if (phase === "healthy") {
    updateClient(client.slug, { status: "active", last_error: null });
    try {
      logActivity("provisioning", `Cliente ${client.slug} no ar (${client.fqdn ?? "?"})`, "success", {
        metadata: { slug: client.slug, fqdn: client.fqdn },
      });
    } catch {}
    // Entrega de credenciais por email (uma vez), se houver email.
    if (client.contact_email && !client.credentials_delivered_at) {
      const r = await deliverCredentials(client.slug);
      await addNotification(
        r.ok ? "✅ Cliente provisionado" : "⚠️ Cliente no ar, email falhou",
        r.ok
          ? `${client.name} (${client.fqdn}) está no ar e recebeu as credenciais por email.`
          : `${client.name} (${client.fqdn}) está no ar, mas o envio do email falhou: ${r.error}. Use "Reenviar" no painel.`,
        r.ok ? "success" : "warning",
        "/saas",
        { slug: client.slug },
      ).catch(() => {});
    } else {
      await addNotification(
        "✅ Cliente provisionado",
        `${client.name} (${client.fqdn}) está no ar. Credenciais disponíveis no painel.`,
        "success",
        "/saas",
        { slug: client.slug },
      ).catch(() => {});
    }
    return;
  }

  if (phase === "failed") {
    updateClient(client.slug, { status: "failed", last_error: "Deploy falhou no Coolify." });
    await addNotification(
      "❌ Falha ao provisionar cliente",
      `O deploy de ${client.name} (${client.slug}) falhou no Coolify. Veja os logs do app e tente reprovisionar.`,
      "error",
      "/saas",
      { slug: client.slug },
    ).catch(() => {});
    return;
  }

  // ainda subindo — aplica timeout para não ficar preso "deploying" pra sempre
  if (ageMs(client.updated_at) > DEPLOY_TIMEOUT_MS) {
    updateClient(client.slug, {
      status: "failed",
      last_error: `Deploy não ficou saudável em ${Math.round(DEPLOY_TIMEOUT_MS / 60000)}min.`,
    });
    await addNotification(
      "❌ Provisionamento expirou",
      `${client.name} (${client.slug}) não ficou saudável a tempo. Verifique o build no Coolify.`,
      "error",
      "/saas",
      { slug: client.slug },
    ).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const deploying = listClients().filter((c) => c.status === "deploying");
    for (const client of deploying) {
      try {
        await advanceClient(client);
      } catch (err) {
        console.warn(`[provision-scheduler] advance ${client.slug} falhou:`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startProvisionScheduler(): void {
  if (started) return;
  started = true;
  if (isContainerDeploy()) {
    // Só o app do dono (modo native) provisiona; o container do cliente não.
    return;
  }
  setTimeout(() => void tick(), 12_000);
  timer = setInterval(() => void tick(), TICK_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** Força uma verificação imediata (usado pela rota após disparar o deploy). */
export async function triggerProvisionCheck(): Promise<void> {
  await tick();
}
