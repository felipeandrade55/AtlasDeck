/**
 * In-memory pairing nonce store for the Telegram quick-connect flow.
 *
 * The wizard generates a short-lived nonce ("atlasdeck_<hex>") and asks
 * the user to /start the bot with that token. The poll endpoint then
 * watches getUpdates for an update carrying `start_param === <nonce>`.
 * Entries expire after 10 min so a forgotten attempt doesn't leak the
 * bot token in process memory.
 */
import crypto from "crypto";

interface PairingEntry {
  botToken: string;
  botUsername: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  lastUpdateId: number;
}

const TTL_MS = 10 * 60 * 1000;
const store = new Map<string, PairingEntry>();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(key);
  }
}

export function createPairing(opts: {
  botToken: string;
  botUsername: string;
  accountId: string;
}): { nonce: string; expiresAt: number } {
  sweep();
  const nonce = `atlasdeck_${crypto.randomBytes(8).toString("hex")}`;
  const now = Date.now();
  store.set(nonce, {
    botToken: opts.botToken,
    botUsername: opts.botUsername,
    accountId: opts.accountId,
    createdAt: now,
    expiresAt: now + TTL_MS,
    lastUpdateId: 0,
  });
  return { nonce, expiresAt: now + TTL_MS };
}

export function getPairing(nonce: string): PairingEntry | null {
  sweep();
  return store.get(nonce) ?? null;
}

export function updatePairingCursor(nonce: string, lastUpdateId: number): void {
  const entry = store.get(nonce);
  if (!entry) return;
  entry.lastUpdateId = lastUpdateId;
}

export function consumePairing(nonce: string): void {
  store.delete(nonce);
}
