/**
 * POST /api/setup/apply
 *
 * "Aplicar configuração" do wizard: depois que o usuário escolheu o modelo
 * (OAuth) e fez a entrevista (identidade/personalidade/dono), este endpoint
 * consolida tudo — sanea a config, reinicia o gateway para carregar o que foi
 * escolhido, e espera ele voltar a aceitar conexões. Self-heal embutido: o
 * restartGateway já tem a cadeia systemd→PM2→processo, então funciona tanto no
 * VPS nativo quanto no container (onde casa com o PM2).
 *
 * Idempotente: pode ser chamado quantas vezes for preciso.
 */
import { NextResponse } from "next/server";
import { restartGateway } from "@/lib/gateway-control";
import { waitForGateway } from "@/lib/openclaw-gateway-wait";
import { checkOpenClawHealth } from "@/lib/openclaw-auto-fix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ApplyStep {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export async function POST() {
  const steps: ApplyStep[] = [];

  // 1. Sweep + restart do gateway (aplica modelo/identidade escolhidos).
  let restartOk = false;
  try {
    const r = await restartGateway();
    restartOk = r.success;
    steps.push({
      key: "gateway-restart",
      label: "Aplicando configuração ao gateway",
      ok: r.success,
      detail: r.runtime,
    });
  } catch (e) {
    steps.push({
      key: "gateway-restart",
      label: "Aplicando configuração ao gateway",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. Espera o gateway aceitar conexões.
  const wait = await waitForGateway({ timeoutMs: 30_000 });
  steps.push({
    key: "gateway-ready",
    label: "Subindo o assistente",
    ok: wait.ready,
    detail: wait.ready ? `pronto na porta ${wait.port}` : `não respondeu em ${wait.elapsedMs}ms`,
  });

  // 3. Snapshot de saúde da config (informativo).
  let configOk = false;
  try {
    const h = checkOpenClawHealth();
    configOk = h.openclawJsonExists;
    steps.push({
      key: "config-health",
      label: "Verificando integridade da config",
      ok: configOk,
    });
  } catch {
    steps.push({ key: "config-health", label: "Verificando integridade da config", ok: false });
  }

  // A barra para avançar é o gateway aceitar conexões.
  return NextResponse.json({
    ok: wait.ready,
    gatewayReady: wait.ready,
    restartOk,
    configOk,
    steps,
  });
}
