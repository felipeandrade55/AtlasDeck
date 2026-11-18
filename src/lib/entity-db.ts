/**
 * Entities (clients, brands, projects, people, organizations) and
 * deliverables (work done for them) — the structure that lets the
 * assistant say "para o cliente A usamos azul #123456 e Montserrat; quer
 * a mesma estrutura de página para o cliente B, com qual identidade?".
 *
 * Lives in memories.db next to the memories it links to.
 *
 * Brand kit = entity.attributes.brand:
 *   { colors?: string[], fonts?: string[], tone?: string, logo?: string,
 *     references?: string[], notes?: string, updated_at?: string }
 */
import { randomUUID } from "crypto";
import { getMemoriesDatabase } from "@/lib/memory-db";

export type EntityType = "client" | "brand" | "project" | "person" | "organization";
export const ENTITY_TYPES: EntityType[] = ["client", "brand", "project", "person", "organization"];

export interface BrandKit {
  colors?: string[];
  fonts?: string[];
  tone?: string;
  logo?: string;
  references?: string[];
  notes?: string;
  updated_at?: string;
}

export interface EntityRow {
  id: string;
  workspace: string;
  type: EntityType;
  name: string;
  slug: string;
  aliases: string[];
  summary: string | null;
  attributes: Record<string, unknown>;
  status: "active" | "archived";
  mention_count: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverableRow {
  id: string;
  workspace: string;
  kind: string;
  title: string;
  client_entity_id: string | null;
  brand_entity_id: string | null;
  project_entity_id: string | null;
  approach: string | null;
  branding: string | null;
  artifact_path: string | null;
  artifact_url: string | null;
  source_task_id: string | null;
  source_thread_id: string | null;
  outcome: string | null;
  feedback: string | null;
  created_at: string;
}

let schemaReady = false;

function db() {
  const d = getMemoriesDatabase();
  if (schemaReady) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      aliases TEXT,
      summary TEXT,
      attributes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      mention_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, type, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_ws ON entities(workspace, type, status);

    CREATE TABLE IF NOT EXISTS entity_links (
      from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_id, to_id, relation)
    );

    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT,
      PRIMARY KEY (memory_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_entities_entity ON memory_entities(entity_id);

    CREATE TABLE IF NOT EXISTS deliverables (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      client_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      brand_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      project_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      approach TEXT,
      branding TEXT,
      artifact_path TEXT,
      artifact_url TEXT,
      source_task_id TEXT,
      source_thread_id TEXT,
      outcome TEXT,
      feedback TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliv_ws ON deliverables(workspace, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliv_client ON deliverables(client_entity_id);
  `);
  schemaReady = true;
  return d;
}

// ─── helpers ───────────────────────────────────────────────────────────

export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "Acme Ltda." → "acme"; legal suffixes dropped so variants collide. */
export function slugify(name: string): string {
  return normalizeName(name)
    .replace(/\b(ltda|ltd|me|eireli|s\/?a|sa|inc|llc|epp|cia)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseEntity(r: Record<string, unknown>): EntityRow {
  return {
    id: r.id as string,
    workspace: r.workspace as string,
    type: r.type as EntityType,
    name: r.name as string,
    slug: r.slug as string,
    aliases: parseJson<string[]>(r.aliases, []),
    summary: (r.summary as string | null) ?? null,
    attributes: parseJson<Record<string, unknown>>(r.attributes, {}),
    status: (r.status as EntityRow["status"]) ?? "active",
    mention_count: Number(r.mention_count ?? 0),
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function cleanList(v: unknown, max = 8): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(/[,;\n]/);
  const out = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
  return out.length ? out : undefined;
}

/** Accepts loose LLM/tool input and returns a tidy brand kit (or null). */
export function normalizeBrandKit(input: unknown): BrandKit | null {
  if (!input) return null;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    const colors = text.match(/#[0-9a-f]{3,8}\b/gi) ?? undefined;
    return { notes: text.slice(0, 500), colors: colors ? [...new Set(colors)] : undefined };
  }
  if (typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const kit: BrandKit = {
    colors: cleanList(o.colors ?? o.cores ?? o.palette ?? o.paleta),
    fonts: cleanList(o.fonts ?? o.fontes ?? o.typography ?? o.tipografia),
    tone: typeof (o.tone ?? o.tom) === "string" ? String(o.tone ?? o.tom).slice(0, 300) : undefined,
    logo: typeof o.logo === "string" ? o.logo.slice(0, 500) : undefined,
    references: cleanList(o.references ?? o.referencias ?? o.referências),
    notes: typeof (o.notes ?? o.notas ?? o.observacoes) === "string" ? String(o.notes ?? o.notas ?? o.observacoes).slice(0, 500) : undefined,
  };
  const has = Object.values(kit).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
  return has ? kit : null;
}

function mergeBrandKit(prev: BrandKit | undefined, next: BrandKit): BrandKit {
  // Newer info wins per field; lists are replaced when the new list is
  // explicit (a corrected palette must not keep the wrong colors).
  return {
    ...(prev ?? {}),
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))),
    updated_at: new Date().toISOString(),
  };
}

export function getBrandKit(entity: EntityRow | null): BrandKit | null {
  const kit = entity?.attributes?.brand as BrandKit | undefined;
  if (!kit) return null;
  const has = (kit.colors?.length ?? 0) > 0 || (kit.fonts?.length ?? 0) > 0 || kit.tone || kit.logo || kit.notes;
  return has ? kit : null;
}

export function describeBrandKit(kit: BrandKit): string {
  const parts: string[] = [];
  if (kit.colors?.length) parts.push(`cores ${kit.colors.join(", ")}`);
  if (kit.fonts?.length) parts.push(`fontes ${kit.fonts.join(", ")}`);
  if (kit.tone) parts.push(`tom ${kit.tone}`);
  if (kit.logo) parts.push(`logo ${kit.logo}`);
  if (kit.references?.length) parts.push(`referências ${kit.references.join(", ")}`);
  if (kit.notes && parts.length < 2) parts.push(kit.notes);
  return parts.join("; ");
}

// ─── entities ──────────────────────────────────────────────────────────

export function getEntity(id: string): EntityRow | null {
  const r = db().prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? parseEntity(r) : null;
}

export function listEntities(opts: {
  workspace?: string;
  type?: EntityType | EntityType[];
  status?: EntityRow["status"];
  search?: string;
  limit?: number;
} = {}): EntityRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workspace) {
    where.push("workspace = ?");
    params.push(opts.workspace);
  }
  if (opts.type) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type];
    where.push(`type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  where.push("status = ?");
  params.push(opts.status ?? "active");
  if (opts.search) {
    where.push("(name LIKE ? OR aliases LIKE ? OR summary LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like);
  }
  const rows = db()
    .prepare(
      `SELECT * FROM entities WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(last_seen_at, updated_at) DESC LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(opts.limit ?? 200, 1), 1000)) as Record<string, unknown>[];
  return rows.map(parseEntity);
}

/** Find by name or alias (normalized), optionally restricted by type. */
export function findEntityByName(workspace: string, name: string, type?: EntityType | EntityType[]): EntityRow | null {
  const slug = slugify(name);
  if (!slug) return null;
  const types = type ? (Array.isArray(type) ? type : [type]) : ENTITY_TYPES;
  const candidates = listEntities({ workspace, type: types, limit: 1000 });
  const norm = normalizeName(name);
  return (
    candidates.find((e) => e.slug === slug) ??
    candidates.find((e) => e.aliases.some((a) => slugify(a) === slug || normalizeName(a) === norm)) ??
    null
  );
}

export interface UpsertEntityInput {
  workspace: string;
  type: EntityType;
  name: string;
  aliases?: string[];
  summary?: string | null;
  attributes?: Record<string, unknown>;
  brand?: unknown;
  /** Count a mention (extraction/turn) and bump last_seen_at. */
  mention?: boolean;
}

export function upsertEntity(input: UpsertEntityInput): EntityRow {
  const d = db();
  const name = input.name.trim().slice(0, 120);
  const type = ENTITY_TYPES.includes(input.type) ? input.type : "organization";
  const existing = findEntityByName(input.workspace, name, type === "client" || type === "organization" ? ["client", "organization", "brand"] : type);
  const now = new Date().toISOString();
  const brand = normalizeBrandKit(input.brand ?? (input.attributes?.brand as unknown));

  if (existing) {
    const attributes: Record<string, unknown> = { ...existing.attributes, ...(input.attributes ?? {}) };
    if (brand) attributes.brand = mergeBrandKit(existing.attributes.brand as BrandKit | undefined, brand);
    else if (existing.attributes.brand) attributes.brand = existing.attributes.brand;
    const aliases = [...new Set([...existing.aliases, ...(input.aliases ?? []), ...(normalizeName(name) !== normalizeName(existing.name) ? [name] : [])])].slice(0, 12);
    // A "client" classification beats a generic "organization".
    const nextType = existing.type === "organization" && type === "client" ? "client" : existing.type;
    d.prepare(
      `UPDATE entities SET type = ?, aliases = ?, summary = COALESCE(?, summary), attributes = ?,
         mention_count = mention_count + ?, last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END,
         status = 'active', updated_at = ?
       WHERE id = ?`,
    ).run(
      nextType,
      JSON.stringify(aliases),
      input.summary?.trim() ? input.summary.trim().slice(0, 600) : null,
      JSON.stringify(attributes),
      input.mention ? 1 : 0,
      input.mention ? 1 : 0,
      now,
      now,
      existing.id,
    );
    return getEntity(existing.id)!;
  }

  const id = randomUUID();
  const attributes: Record<string, unknown> = { ...(input.attributes ?? {}) };
  if (brand) attributes.brand = mergeBrandKit(undefined, brand);
  d.prepare(
    `INSERT INTO entities (id, workspace, type, name, slug, aliases, summary, attributes, mention_count, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace,
    type,
    name,
    slugify(name) || id.slice(0, 8),
    JSON.stringify(input.aliases ?? []),
    input.summary?.trim() ? input.summary.trim().slice(0, 600) : null,
    JSON.stringify(attributes),
    input.mention ? 1 : 0,
    input.mention ? now : null,
    now,
    now,
  );
  return getEntity(id)!;
}

export function updateEntity(
  id: string,
  patch: { name?: string; summary?: string | null; aliases?: string[]; brand?: unknown; status?: EntityRow["status"]; type?: EntityType },
): EntityRow | null {
  const current = getEntity(id);
  if (!current) return null;
  const attributes = { ...current.attributes };
  if (patch.brand !== undefined) {
    const kit = normalizeBrandKit(patch.brand);
    if (kit) attributes.brand = { ...kit, updated_at: new Date().toISOString() };
    else delete attributes.brand;
  }
  db()
    .prepare(
      `UPDATE entities SET name = ?, slug = ?, type = ?, summary = ?, aliases = ?, attributes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(
      patch.name?.trim() || current.name,
      slugify(patch.name?.trim() || current.name) || current.slug,
      patch.type && ENTITY_TYPES.includes(patch.type) ? patch.type : current.type,
      patch.summary !== undefined ? patch.summary : current.summary,
      JSON.stringify(patch.aliases ?? current.aliases),
      JSON.stringify(attributes),
      patch.status ?? current.status,
      id,
    );
  return getEntity(id);
}

export function deleteEntity(id: string): boolean {
  return db().prepare(`DELETE FROM entities WHERE id = ?`).run(id).changes > 0;
}

export function linkMemoryToEntity(memoryId: string, entityId: string, role?: string): void {
  db()
    .prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)`)
    .run(memoryId, entityId, role ?? null);
}

export function memoryIdsForEntity(entityId: string, limit = 20): string[] {
  return (
    db()
      .prepare(
        `SELECT me.memory_id FROM memory_entities me JOIN memories m ON m.id = me.memory_id
         WHERE me.entity_id = ? AND m.archived = 0 ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(entityId, limit) as Array<{ memory_id: string }>
  ).map((r) => r.memory_id);
}

// ─── mention detection ─────────────────────────────────────────────────

let mentionCache: { at: number; workspace: string; list: Array<{ entity: EntityRow; patterns: RegExp[] }> } | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entities whose name/alias appears in `text` (diacritics/case-insensitive). */
export function findMentionedEntities(workspace: string, text: string, types?: EntityType[]): EntityRow[] {
  if (!mentionCache || mentionCache.workspace !== workspace || Date.now() - mentionCache.at > 60_000) {
    const list = listEntities({ workspace, limit: 1000 }).map((entity) => ({
      entity,
      patterns: [entity.name, ...entity.aliases]
        .map(normalizeName)
        .filter((n) => n.length >= 3)
        .map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "u")),
    }));
    mentionCache = { at: Date.now(), workspace, list };
  }
  const norm = normalizeName(text);
  return mentionCache.list
    .filter(({ entity, patterns }) => (!types || types.includes(entity.type)) && patterns.some((p) => p.test(norm)))
    .map(({ entity }) => entity);
}

export function invalidateMentionCache(): void {
  mentionCache = null;
}

// ─── deliverables ──────────────────────────────────────────────────────

function parseDeliverable(r: Record<string, unknown>): DeliverableRow {
  return r as unknown as DeliverableRow;
}

export function logDeliverable(input: {
  workspace: string;
  kind: string;
  title: string;
  clientName?: string | null;
  clientEntityId?: string | null;
  approach?: string | null;
  branding?: string | null;
  artifactPath?: string | null;
  artifactUrl?: string | null;
  sourceTaskId?: string | null;
  sourceThreadId?: string | null;
  outcome?: string | null;
}): DeliverableRow {
  const d = db();
  let clientId = input.clientEntityId ?? null;
  if (!clientId && input.clientName?.trim()) {
    clientId = upsertEntity({ workspace: input.workspace, type: "client", name: input.clientName, mention: true }).id;
    invalidateMentionCache();
  }
  const kind = (input.kind || "outro").toLowerCase().replace(/\s+/g, "_").slice(0, 40);
  const title = input.title.trim().slice(0, 200) || kind;

  // Same deliverable reported twice (extraction + task hook): update instead.
  const dup = d
    .prepare(
      `SELECT * FROM deliverables WHERE workspace = ? AND kind = ? AND COALESCE(client_entity_id,'') = COALESCE(?, '')
         AND (lower(title) = lower(?) OR (source_task_id IS NOT NULL AND source_task_id = ?))
         AND created_at >= datetime('now', '-3 days') LIMIT 1`,
    )
    .get(input.workspace, kind, clientId, title, input.sourceTaskId ?? null) as Record<string, unknown> | undefined;
  if (dup) {
    d.prepare(
      `UPDATE deliverables SET approach = COALESCE(?, approach), branding = COALESCE(?, branding),
         artifact_path = COALESCE(?, artifact_path), artifact_url = COALESCE(?, artifact_url),
         source_task_id = COALESCE(source_task_id, ?), source_thread_id = COALESCE(source_thread_id, ?),
         outcome = COALESCE(?, outcome) WHERE id = ?`,
    ).run(
      input.approach ?? null,
      input.branding ?? null,
      input.artifactPath ?? null,
      input.artifactUrl ?? null,
      input.sourceTaskId ?? null,
      input.sourceThreadId ?? null,
      input.outcome ?? null,
      dup.id,
    );
    return parseDeliverable(d.prepare(`SELECT * FROM deliverables WHERE id = ?`).get(dup.id) as Record<string, unknown>);
  }

  const id = randomUUID();
  d.prepare(
    `INSERT INTO deliverables (id, workspace, kind, title, client_entity_id, approach, branding, artifact_path, artifact_url, source_task_id, source_thread_id, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace,
    kind,
    title,
    clientId,
    input.approach?.slice(0, 800) ?? null,
    input.branding?.slice(0, 800) ?? null,
    input.artifactPath ?? null,
    input.artifactUrl ?? null,
    input.sourceTaskId ?? null,
    input.sourceThreadId ?? null,
    input.outcome ?? null,
  );
  return parseDeliverable(d.prepare(`SELECT * FROM deliverables WHERE id = ?`).get(id) as Record<string, unknown>);
}

export function listDeliverables(opts: {
  workspace?: string;
  kind?: string | string[];
  clientEntityId?: string;
  excludeClientEntityIds?: string[];
  limit?: number;
} = {}): Array<DeliverableRow & { client_name: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workspace) {
    where.push("d.workspace = ?");
    params.push(opts.workspace);
  }
  if (opts.kind) {
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    where.push(`d.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (opts.clientEntityId) {
    where.push("d.client_entity_id = ?");
    params.push(opts.clientEntityId);
  }
  if (opts.excludeClientEntityIds?.length) {
    where.push(`COALESCE(d.client_entity_id, '') NOT IN (${opts.excludeClientEntityIds.map(() => "?").join(",")})`);
    params.push(...opts.excludeClientEntityIds);
  }
  const rows = db()
    .prepare(
      `SELECT d.*, e.name AS client_name FROM deliverables d LEFT JOIN entities e ON e.id = d.client_entity_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(opts.limit ?? 50, 1), 500)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...parseDeliverable(r), client_name: (r.client_name as string | null) ?? null }));
}

/** Reflect the owner's approve/reject verdict on deliverables logged from tasks. */
export function setDeliverableOutcomeByTask(taskId: string, outcome: string, feedback: string | null): number {
  return db()
    .prepare(
      `UPDATE deliverables SET outcome = ?, feedback = COALESCE(?, feedback)
       WHERE source_task_id = ? AND (outcome IS NULL OR outcome != ? OR COALESCE(feedback,'') != COALESCE(?, feedback, ''))`,
    )
    .run(outcome, feedback, taskId, outcome, feedback).changes;
}

export function deleteDeliverable(id: string): boolean {
  return db().prepare(`DELETE FROM deliverables WHERE id = ?`).run(id).changes > 0;
}

/** True when the user asked not to be prompted about reusing past work. */
export function reusePromptSuppressed(workspace: string): boolean {
  const row = getMemoriesDatabase()
    .prepare(
      `SELECT 1 FROM memories WHERE workspace = ? AND archived = 0 AND tags LIKE '%"pref:no-reuse-prompt"%' LIMIT 1`,
    )
    .get(workspace);
  return Boolean(row);
}
