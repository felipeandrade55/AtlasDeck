/**
 * Local storage for IMAP/SMTP accounts.
 *
 * Lives in `data/email-accounts.json` (chmod 600). Same pattern as
 * `provider-keys.ts` and `telegram-accounts-local.ts` — credentials
 * never leave the AtlasDeck box and are not synced to `openclaw.json`.
 *
 * AtlasDeck is now the sole owner of the IMAP/SMTP connection
 * (independent from the OpenClaw daemon, which still has its own
 * email skill for the daily summary cron).
 */
import fs from "fs";
import path from "path";

const STORE_PATH = path.join(process.cwd(), "data", "email-accounts.json");

export interface ImapConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
}

export interface StoredAccount {
  id: string;
  name?: string;
  emailAddress: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  status: "configured" | "error" | "not_configured";
}

export type PublicAccount = Omit<StoredAccount, "imap" | "smtp"> & {
  imap: Omit<ImapConfig, "password">;
  smtp: Omit<SmtpConfig, "password">;
  issues?: string[];
};

interface StoreShape {
  accounts: Record<string, StoredAccount>;
}

function readStore(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.accounts && typeof parsed.accounts === "object") {
      return parsed as StoreShape;
    }
    return { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

function writeStore(data: StoreShape): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    // chmod may fail on Windows — ignore
  }
}

function toPublic(a: StoredAccount): PublicAccount {
  const { password: _ip, ...imap } = a.imap;
  const { password: _sp, ...smtp } = a.smtp;
  void _ip;
  void _sp;
  return {
    ...a,
    imap,
    smtp,
  };
}

export function listAccounts(): PublicAccount[] {
  const store = readStore();
  return Object.values(store.accounts)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toPublic);
}

export function listAccountsWithSecrets(): StoredAccount[] {
  const store = readStore();
  return Object.values(store.accounts).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAccount(id: string): StoredAccount | null {
  return readStore().accounts[id] ?? null;
}

export function getAccountPublic(id: string): PublicAccount | null {
  const a = getAccount(id);
  return a ? toPublic(a) : null;
}

export interface AccountUpsertInput {
  id: string;
  name?: string;
  emailAddress: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
}

export function upsertAccount(input: AccountUpsertInput): StoredAccount {
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.accounts[input.id];
  const next: StoredAccount = {
    id: input.id,
    name: input.name ?? existing?.name,
    emailAddress: input.emailAddress,
    imap: input.imap,
    smtp: input.smtp,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastError: null,
    status: existing?.status ?? "not_configured",
  };
  store.accounts[input.id] = next;
  writeStore(store);
  return next;
}

export function patchAccount(id: string, patch: Partial<AccountUpsertInput>): StoredAccount | null {
  const store = readStore();
  const existing = store.accounts[id];
  if (!existing) return null;
  const next: StoredAccount = {
    ...existing,
    name: patch.name ?? existing.name,
    emailAddress: patch.emailAddress ?? existing.emailAddress,
    imap: patch.imap ? { ...existing.imap, ...patch.imap } : existing.imap,
    smtp: patch.smtp ? { ...existing.smtp, ...patch.smtp } : existing.smtp,
    updatedAt: new Date().toISOString(),
  };
  store.accounts[id] = next;
  writeStore(store);
  return next;
}

export function deleteAccount(id: string): boolean {
  const store = readStore();
  if (!(id in store.accounts)) return false;
  delete store.accounts[id];
  writeStore(store);
  return true;
}

export function markAccountStatus(
  id: string,
  status: StoredAccount["status"],
  error?: string | null,
): void {
  const store = readStore();
  const existing = store.accounts[id];
  if (!existing) return;
  existing.status = status;
  existing.lastError = error ?? null;
  if (status === "configured") {
    existing.lastSyncAt = new Date().toISOString();
  }
  existing.updatedAt = new Date().toISOString();
  writeStore(store);
}

export function ensureStoreExists(): void {
  if (!fs.existsSync(STORE_PATH)) {
    writeStore({ accounts: {} });
  }
}

export function countAccounts(): number {
  return Object.keys(readStore().accounts).length;
}
