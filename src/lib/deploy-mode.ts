/**
 * Deploy mode — distingue a instalação NATIVA no VPS (padrão histórico, como o
 * AtlasDeck roda hoje) da instalação CONTAINERIZADA (Coolify, padrão SaaS).
 *
 * Em modo "coolify" o OpenClaw já vem embutido na imagem e o gateway sobe sob
 * PM2 no mesmo container — o wizard NÃO deve rodar `npm install -g openclaw`.
 *
 * Controlado pela env `ATLASDECK_DEPLOY_MODE`. Ausente ⇒ "native" (não muda
 * absolutamente nada no caminho do VPS). Server-only (lê process.env); para o
 * client, o valor é exposto via /api/setup/status.
 */
export type DeployMode = "native" | "coolify";

export function getDeployMode(): DeployMode {
  const v = (process.env.ATLASDECK_DEPLOY_MODE || "").trim().toLowerCase();
  if (v === "coolify" || v === "container" || v === "docker") return "coolify";
  return "native";
}

export function isContainerDeploy(): boolean {
  return getDeployMode() === "coolify";
}
