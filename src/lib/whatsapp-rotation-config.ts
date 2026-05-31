/**
 * Persists the WhatsApp auto-rotation schedule chosen by the user in the
 * setup modal. Lives in `data/whatsapp-rotation-config.json` (AtlasDeck-
 * local, NOT openclaw.json) because the schedule is an AtlasDeck-side
 * watchdog concern and OpenClaw's strict schema rejects unknown keys.
 *
 * Default: disabled. Auto-rotation is a power-user feature — surfacing
 * it as opt-in keeps the "zero friction for leigos" promise: nothing
 * fires unsupervised until the user explicitly turns it on.
 */
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "whatsapp-rotation-config.json");

export interface WhatsappRotationConfig {
  /** Master switch. When false, the watchdog skips rotation regardless
   *  of `intervalHours`. The manual rotate button still works. */
  enabled: boolean;
  /** How often to rotate, in hours. Min 1 (anything finer would clobber
   *  active conversations mid-burst). Max 168 (one week — anything
   *  longer defeats the purpose of auto-rotation). */
  intervalHours: number;
  /** Last successful auto-rotation timestamp (epoch ms). The watchdog
   *  uses this + intervalHours to decide when to fire. */
  lastRotatedAt: number;
}

const DEFAULTS: WhatsappRotationConfig = {
  enabled: false,
  intervalHours: 24,
  lastRotatedAt: 0,
};

export function getWhatsappRotationConfig(): WhatsappRotationConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
      intervalHours: clampHours(parsed.intervalHours),
      lastRotatedAt: typeof parsed.lastRotatedAt === "number" ? parsed.lastRotatedAt : 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setWhatsappRotationConfig(
  patch: Partial<Omit<WhatsappRotationConfig, "lastRotatedAt">>,
): WhatsappRotationConfig {
  const current = getWhatsappRotationConfig();
  const next: WhatsappRotationConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    intervalHours: patch.intervalHours !== undefined ? clampHours(patch.intervalHours) : current.intervalHours,
    lastRotatedAt: current.lastRotatedAt,
  };
  write(next);
  return next;
}

export function markWhatsappRotated(at: number = Date.now()): void {
  const current = getWhatsappRotationConfig();
  write({ ...current, lastRotatedAt: at });
}

function clampHours(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.intervalHours;
  if (n < 1) return 1;
  if (n > 168) return 168;
  return Math.round(n);
}

function write(cfg: WhatsappRotationConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}
