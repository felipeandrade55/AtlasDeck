/**
 * Persists the WhatsApp auto-rotation schedule chosen by the user in the
 * setup modal. Lives in `data/whatsapp-rotation-config.json` (AtlasDeck-
 * local, NOT openclaw.json) because the schedule is an AtlasDeck-side
 * watchdog concern and OpenClaw's strict schema rejects unknown keys.
 *
 * Default: rotation disabled, cleanup enabled with 7-day retention.
 * Auto-rotation itself is opt-in (zero-friction promise: nothing fires
 * unsupervised). Auto-cleanup defaults ON because the only thing it
 * touches is `.reset.<ts>.jsonl` artifacts which are inert by design —
 * leaving them there only burns disk.
 */
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "whatsapp-rotation-config.json");

export interface WhatsappRotationConfig {
  /** Master switch for AUTO rotation. When false, the watchdog skips
   *  rotation regardless of `intervalHours`. The manual rotate button
   *  still works. */
  enabled: boolean;
  /** How often to rotate, in hours. Min 1 (anything finer would clobber
   *  active conversations mid-burst). Max 168 (one week — anything
   *  longer defeats the purpose of auto-rotation). */
  intervalHours: number;
  /** Last successful auto-rotation timestamp (epoch ms). The watchdog
   *  uses this + intervalHours to decide when to fire. */
  lastRotatedAt: number;
  /** Delete `.reset.<ts>.jsonl` files older than this many days. Runs
   *  on every watchdog tick (cheap fs.readdir + stat). 0 disables.
   *  Default 7 — keeps a week of artifacts for forensic, then reclaims
   *  the disk. Independent of `enabled` (rotation toggle) so users can
   *  do manual-rotate + auto-cleanup without auto-rotate firing. */
  cleanupDays: number;
  /** Last cleanup timestamp + stats so the UI can show "X MB freed
   *  N hours ago". */
  lastCleanupAt: number;
  lastCleanupFilesDeleted: number;
  lastCleanupBytesFreed: number;
}

const DEFAULTS: WhatsappRotationConfig = {
  enabled: false,
  intervalHours: 24,
  lastRotatedAt: 0,
  cleanupDays: 7,
  lastCleanupAt: 0,
  lastCleanupFilesDeleted: 0,
  lastCleanupBytesFreed: 0,
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
      cleanupDays: clampCleanupDays(parsed.cleanupDays),
      lastCleanupAt: typeof parsed.lastCleanupAt === "number" ? parsed.lastCleanupAt : 0,
      lastCleanupFilesDeleted: typeof parsed.lastCleanupFilesDeleted === "number" ? parsed.lastCleanupFilesDeleted : 0,
      lastCleanupBytesFreed: typeof parsed.lastCleanupBytesFreed === "number" ? parsed.lastCleanupBytesFreed : 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setWhatsappRotationConfig(
  patch: Partial<Pick<WhatsappRotationConfig, "enabled" | "intervalHours" | "cleanupDays">>,
): WhatsappRotationConfig {
  const current = getWhatsappRotationConfig();
  const next: WhatsappRotationConfig = {
    ...current,
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    intervalHours: patch.intervalHours !== undefined ? clampHours(patch.intervalHours) : current.intervalHours,
    cleanupDays: patch.cleanupDays !== undefined ? clampCleanupDays(patch.cleanupDays) : current.cleanupDays,
  };
  write(next);
  return next;
}

export function markWhatsappRotated(at: number = Date.now()): void {
  const current = getWhatsappRotationConfig();
  write({ ...current, lastRotatedAt: at });
}

export function markWhatsappCleanup(
  filesDeleted: number,
  bytesFreed: number,
  at: number = Date.now(),
): void {
  const current = getWhatsappRotationConfig();
  write({
    ...current,
    lastCleanupAt: at,
    lastCleanupFilesDeleted: filesDeleted,
    lastCleanupBytesFreed: bytesFreed,
  });
}

function clampHours(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.intervalHours;
  if (n < 1) return 1;
  if (n > 168) return 168;
  return Math.round(n);
}

function clampCleanupDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.cleanupDays;
  // 0 disables (no cleanup). Cap at 365 — keeping a year of artifacts
  // is already absurd and longer values are almost certainly typos.
  if (n < 0) return 0;
  if (n > 365) return 365;
  return Math.round(n);
}

function write(cfg: WhatsappRotationConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}
