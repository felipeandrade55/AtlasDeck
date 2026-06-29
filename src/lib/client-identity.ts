/**
 * Per-client identity for the SaaS subdomain scheme.
 *
 * Each client runs as its own container (1 Coolify app/client) reachable at
 *   <slug>.<base-domain>      e.g. felipeandrade.ih01.atlasdeck.ia.br
 *
 * The "slug" is the variable label in front of the fixed base domain. Two
 * ways to know it, in order of reliability:
 *   1. ATLASDECK_CLIENT_SLUG  — injected at provision time. Host-independent,
 *      works for internal/SSR requests that carry no Host header. PREFERRED.
 *   2. Parsed from the request Host by stripping the base-domain suffix.
 *
 * Base domain is configurable via ATLASDECK_BASE_DOMAIN (default below) so we
 * can move the zone (ih02…, another apex) without touching code.
 */

const DEFAULT_BASE_DOMAIN = "ih01.atlasdeck.ia.br";

/** The fixed suffix every client subdomain sits under (no leading/trailing dots). */
export function getBaseDomain(): string {
  return (process.env.ATLASDECK_BASE_DOMAIN || DEFAULT_BASE_DOMAIN)
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function normalizeHost(host: string): string {
  // Drop port, trailing dot, surrounding whitespace; lowercase.
  return host.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Extract the client slug (everything before the base domain) from a host.
 *
 *   felipeandrade.ih01.atlasdeck.ia.br  → "felipeandrade"
 *   eduardo.ih01.atlasdeck.ia.br:443    → "eduardo"
 *   ih01.atlasdeck.ia.br                → null  (it's the base itself)
 *   anything.else.com                   → null  (not under the base)
 *
 * Returns null when the host isn't under the base domain or has no prefix.
 */
export function extractClientSlug(
  host: string | null | undefined,
  baseDomain: string = getBaseDomain(),
): string | null {
  if (!host) return null;
  const h = normalizeHost(host);
  const base = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!base || h === base) return null;
  const suffix = `.${base}`;
  if (!h.endsWith(suffix)) return null;
  const prefix = h.slice(0, -suffix.length);
  // Our scheme uses a single label; if a deeper prefix shows up
  // (a.b.<base>), the slug is the left-most label.
  return prefix ? prefix.split(".")[0] : null;
}

/**
 * The slug for THIS install. Prefers the provisioned env var; falls back to
 * parsing the host you pass in (e.g. from request headers). Returns null when
 * neither is available (e.g. local dev on localhost without the env set).
 */
export function getClientSlug(host?: string | null): string | null {
  const fromEnv = process.env.ATLASDECK_CLIENT_SLUG?.trim();
  if (fromEnv) return fromEnv;
  return extractClientSlug(host ?? null);
}

/** Build a client's canonical FQDN from its slug. */
export function clientFqdn(slug: string, baseDomain: string = getBaseDomain()): string {
  return `${slug}.${baseDomain}`;
}

/**
 * Normalize an arbitrary name into a DNS/Coolify-safe slug: lowercase,
 * accents stripped, non-alphanumerics collapsed to single dashes, trimmed.
 * Single source of truth shared by the CLI, the admin API and the webhook.
 *
 *   "Felipe Andrade"  → "felipe-andrade"
 *   "Bruno Sénior!!"  → "bruno-senior"
 */
export function slugify(input: string): string {
  return (input || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
