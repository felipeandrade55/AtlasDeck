/**
 * Classify Coolify deploy/app status into a small, stable vocabulary the
 * provisioning state machine understands. Coolify is asynchronous: a freshly
 * created app reports e.g. "running:unhealthy" during the build's start
 * period, then "running:healthy" once the HEALTHCHECK passes (validated
 * empirically on this same Coolify). The provision scheduler polls these
 * per tick rather than holding a long-lived loop.
 */
import { coolify } from "./coolify";

export type DeployPhase = "running" | "healthy" | "failed" | "unknown";

/** App-level status (GET /applications/{uuid} → status). The truth signal. */
export function classifyAppStatus(status: string | undefined | null): DeployPhase {
  const s = (status || "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("healthy") && !s.includes("unhealthy")) return "healthy";
  if (s.includes("exited") || s.includes("error") || s.includes("failed")) return "failed";
  // running:unhealthy / starting / degraded → still coming up
  return "running";
}

/** Deployment-level status (GET /deployments/{uuid} → status). */
export function classifyDeploymentStatus(status: string | undefined | null): DeployPhase {
  const s = (status || "").toLowerCase();
  if (!s) return "unknown";
  if (s === "finished") return "healthy";
  if (s === "failed" || s.includes("cancel")) return "failed";
  return "running"; // queued | in_progress
}

/**
 * One-shot check of where a client's deploy stands, preferring the app
 * status (most reliable) and falling back to the deployment record.
 */
export async function checkDeployPhase(
  appUuid: string | null,
  deploymentUuid: string | null,
): Promise<DeployPhase> {
  if (appUuid) {
    try {
      const app = await coolify.getApplication(appUuid);
      const phase = classifyAppStatus(app.status);
      if (phase === "healthy" || phase === "failed") return phase;
    } catch {
      /* fall through to deployment check */
    }
  }
  if (deploymentUuid) {
    try {
      const dep = await coolify.getDeployment(deploymentUuid);
      return classifyDeploymentStatus(dep.status);
    } catch {
      return "unknown";
    }
  }
  return "running";
}
