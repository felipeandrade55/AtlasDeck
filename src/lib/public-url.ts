/**
 * Resolve the PUBLIC, internet-reachable base URL for AtlasDeck — the one we
 * hand to outside people (e.g. a WhatsApp contact opening a booking link).
 *
 * Order of preference:
 *   1. NEXT_PUBLIC_PUBLIC_BASE_URL — the configured public domain
 *      (set in .env: https://atlasdeck.egis.app.br).
 *   2. ATLASDECK_BASE_URL — internal base; only a sane fallback when the
 *      public one isn't set (NOT shareable if it's 127.0.0.1/localhost).
 *   3. http://localhost:3000 — last-resort dev default.
 *
 * Mirrors the inline logic in /api/calendar/share so booking URLs are built
 * the same way everywhere.
 */
export function resolvePublicBaseUrl(): string {
  const envBase = (
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ?? process.env.ATLASDECK_BASE_URL
  )?.replace(/\/$/, "");
  return envBase || "http://localhost:3000";
}

/** Full, shareable booking URL for a booking-link token. */
export function buildBookingUrl(token: string): string {
  return `${resolvePublicBaseUrl()}/book/${token}`;
}

/**
 * True when the resolved public base is actually reachable from the internet
 * (i.e. not localhost/127.0.0.1). Callers can warn when a link won't work
 * for an external contact.
 */
export function isPublicBaseShareable(): boolean {
  const base = resolvePublicBaseUrl();
  return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base);
}
