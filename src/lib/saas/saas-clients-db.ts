/**
 * SaaS client registry (data/saas-clients.db).
 *
 * One row per provisioned client. Mirrors the vps-db.ts pattern: single
 * better-sqlite3 handle, WAL, CREATE TABLE IF NOT EXISTS, prepared statements,
 * rowToClient(). Lives only on the OWNER's control plane.
 *
 * Secrets note: admin_password / auth_secret are stored in plaintext in this
 * local, owner-only DB — same trust model as data/provider-keys.json (API
 * keys in plaintext). It lets the panel show / resend credentials. Never
 * expose these via list endpoints to anyone but the authenticated owner.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "saas-clients.db");

export type ClientStatus =
  | "pending"
  | "provisioning"
  | "deploying"
  | "active"
  | "failed"
  | "suspended";

export type ClientSource = "admin" | "mercadopago";

export interface SaasClient {
  slug: string;
  name: string;
  contact_email: string | null;
  plan: string | null;
  status: ClientStatus;
  fqdn: string | null;
  coolify_project_uuid: string | null;
  coolify_app_uuid: string | null;
  coolify_deployment_uuid: string | null;
  admin_password: string | null;
  auth_secret: string | null;
  credentials_delivered_at: string | null;
  delivery_channel: string | null;
  source: ClientSource;
  mp_payer_id: string | null;
  mp_subscription_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS saas_clients (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_email TEXT,
      plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      fqdn TEXT,
      coolify_project_uuid TEXT,
      coolify_app_uuid TEXT,
      coolify_deployment_uuid TEXT,
      admin_password TEXT,
      auth_secret TEXT,
      credentials_delivered_at TEXT,
      delivery_channel TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      mp_payer_id TEXT,
      mp_subscription_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saas_clients_status ON saas_clients(status);
    CREATE INDEX IF NOT EXISTS idx_saas_clients_subscription ON saas_clients(mp_subscription_id);
  `);
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch {
    /* windows / non-owner fs — ignore */
  }
  return _db;
}

const COLUMNS: Array<keyof SaasClient> = [
  "slug", "name", "contact_email", "plan", "status", "fqdn",
  "coolify_project_uuid", "coolify_app_uuid", "coolify_deployment_uuid",
  "admin_password", "auth_secret", "credentials_delivered_at", "delivery_channel",
  "source", "mp_payer_id", "mp_subscription_id", "last_error", "created_at", "updated_at",
];

function rowToClient(row: Record<string, unknown>): SaasClient {
  return row as unknown as SaasClient;
}

export interface CreateClientInput {
  slug: string;
  name: string;
  contact_email?: string | null;
  plan?: string | null;
  fqdn?: string | null;
  source?: ClientSource;
  mp_payer_id?: string | null;
  mp_subscription_id?: string | null;
}

/** Insert a fresh client row (status='pending'). Throws if the slug exists. */
export function createClient(input: CreateClientInput): SaasClient {
  const db = getDb();
  db.prepare(
    `INSERT INTO saas_clients (slug, name, contact_email, plan, status, fqdn, source, mp_payer_id, mp_subscription_id)
     VALUES (@slug, @name, @contact_email, @plan, 'pending', @fqdn, @source, @mp_payer_id, @mp_subscription_id)`,
  ).run({
    slug: input.slug,
    name: input.name,
    contact_email: input.contact_email ?? null,
    plan: input.plan ?? null,
    fqdn: input.fqdn ?? null,
    source: input.source ?? "admin",
    mp_payer_id: input.mp_payer_id ?? null,
    mp_subscription_id: input.mp_subscription_id ?? null,
  });
  return getClient(input.slug)!;
}

export function getClient(slug: string): SaasClient | null {
  const row = getDb().prepare(`SELECT * FROM saas_clients WHERE slug = ?`).get(slug) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToClient(row) : null;
}

export function listClients(): SaasClient[] {
  const rows = getDb()
    .prepare(`SELECT * FROM saas_clients ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToClient);
}

/** Patch arbitrary columns; always bumps updated_at. Returns the new row. */
export function updateClient(slug: string, patch: Partial<SaasClient>): SaasClient | null {
  const keys = Object.keys(patch).filter(
    (k) => COLUMNS.includes(k as keyof SaasClient) && k !== "slug" && k !== "created_at",
  );
  if (keys.length === 0) {
    // still bump updated_at
    getDb().prepare(`UPDATE saas_clients SET updated_at = datetime('now') WHERE slug = ?`).run(slug);
    return getClient(slug);
  }
  const setSql = keys.map((k) => `${k} = @${k}`).join(", ");
  const params: Record<string, unknown> = { slug };
  for (const k of keys) params[k] = (patch as Record<string, unknown>)[k];
  getDb()
    .prepare(`UPDATE saas_clients SET ${setSql}, updated_at = datetime('now') WHERE slug = @slug`)
    .run(params);
  return getClient(slug);
}

export function deleteClient(slug: string): boolean {
  const info = getDb().prepare(`DELETE FROM saas_clients WHERE slug = ?`).run(slug);
  return info.changes > 0;
}

/** Public-safe view (drops secrets) for list/detail endpoints by default. */
export function toPublicClient(c: SaasClient): Omit<SaasClient, "admin_password" | "auth_secret"> {
  const { admin_password: _p, auth_secret: _s, ...rest } = c;
  void _p;
  void _s;
  return rest;
}
