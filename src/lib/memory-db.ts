/**
 * Structured memory store (Phase 2/3 of the memory subsystem).
 *
 * Stores typed memories (episodic/semantic/procedural/identity) with
 * embeddings as raw BLOBs and runs k-NN searches in JavaScript.
 *
 * Why JS-cosine instead of sqlite-vec:
 *   - Keeps the 1-click install simple: no native extension to load
 *   - Single-user scale (a few thousand memories) is comfortably fast
 *   - Same module can be upgraded later to use sqlite-vec without
 *     changing the calling API
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.cwd(), "data", "memories.db");

export type MemoryType =
  | "episodic"
  | "semantic"
  | "procedural"
  | "identity";

export type MemorySource =
  | "extraction"
  | "manual"
  | "reflection"
  | "import";

export interface MemoryRow {
  id: string;
  workspace: string;
  agent_id: string | null;
  type: MemoryType;
  title: string;
  content: string;
  summary: string | null;
  source: MemorySource;
  source_session_id: string | null;
  source_file_path: string | null;
  tags: string[];
  importance: number;
  pinned: boolean;
  access_count: number;
  last_accessed_at: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  archived: boolean;
  language: string | null;
  probation_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryInsert {
  id?: string;
  workspace: string;
  agent_id?: string | null;
  type: MemoryType;
  title: string;
  content: string;
  summary?: string | null;
  source: MemorySource;
  source_session_id?: string | null;
  source_file_path?: string | null;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  embedding?: Float32Array | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  language?: string | null;
  probation_until?: string | null;
}

export interface MemoryUpdate {
  title?: string;
  content?: string;
  summary?: string | null;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  archived?: boolean;
  probation_until?: string | null;
  language?: string | null;
}

export type LinkKind =
  | "related"
  | "contradicts"
  | "supersedes"
  | "caused_by"
  | "duplicate_of"
  | "derived_from"
  | "superseded_by";

export interface MemoryLinkRow {
  id: string;
  from_id: string;
  to_id: string;
  kind: LinkKind;
  weight: number;
  source: "cosine" | "llm" | "manual";
  created_at: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      agent_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      source_session_id TEXT,
      source_file_path TEXT,
      tags TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      pinned INTEGER NOT NULL DEFAULT 0,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      embedding_dim INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      probation_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mem_workspace ON memories(workspace);
    CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_mem_archived ON memories(archived);
    CREATE INDEX IF NOT EXISTS idx_mem_pinned ON memories(pinned);
    CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mem_dedup
      ON memories(workspace, source, COALESCE(source_file_path, ''), title);

    CREATE TABLE IF NOT EXISTS memory_links (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_id, to_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_id);
    CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_id);
    CREATE INDEX IF NOT EXISTS idx_links_kind ON memory_links(kind);

    CREATE TABLE IF NOT EXISTS extraction_cursors (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      last_line INTEGER NOT NULL DEFAULT 0,
      last_processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      bytes_seen INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      vote INTEGER NOT NULL,
      context TEXT,
      query TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Forward-compat migration: add columns if upgrading from a previous schema
  const cols = _db
    .prepare("PRAGMA table_info(memories)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("probation_until")) {
    _db.exec("ALTER TABLE memories ADD COLUMN probation_until TEXT");
  }
  if (!has("language")) {
    _db.exec("ALTER TABLE memories ADD COLUMN language TEXT");
  }

  return _db;
}

function parseRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: row.id as string,
    workspace: row.workspace as string,
    agent_id: (row.agent_id as string | null) ?? null,
    type: row.type as MemoryType,
    title: row.title as string,
    content: row.content as string,
    summary: (row.summary as string | null) ?? null,
    source: row.source as MemorySource,
    source_session_id: (row.source_session_id as string | null) ?? null,
    source_file_path: (row.source_file_path as string | null) ?? null,
    tags: row.tags ? safeJsonArray(row.tags as string) : [],
    importance: Number(row.importance ?? 0.5),
    pinned: Boolean(row.pinned),
    access_count: Number(row.access_count ?? 0),
    last_accessed_at: (row.last_accessed_at as string | null) ?? null,
    embedding_model: (row.embedding_model as string | null) ?? null,
    embedding_dim: row.embedding_dim != null ? Number(row.embedding_dim) : null,
    archived: Boolean(row.archived),
    language: (row.language as string | null) ?? null,
    probation_until: (row.probation_until as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function embeddingToBlob(vec: Float32Array | null | undefined): Buffer | null {
  if (!vec) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToEmbedding(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.length === 0) return null;
  return new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
}

/**
 * Insert (or update when (workspace, source, source_file_path, title)
 * collides) a memory. Returns the resulting row.
 */
export function upsertMemory(input: MemoryInsert): MemoryRow {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  const tags = JSON.stringify(input.tags ?? []);
  const blob = embeddingToBlob(input.embedding);

  db.prepare(
    `INSERT INTO memories (
        id, workspace, agent_id, type, title, content, summary, source,
        source_session_id, source_file_path, tags, importance, pinned,
        embedding, embedding_model, embedding_dim, language, probation_until,
        created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace, source, COALESCE(source_file_path, ''), title)
     DO UPDATE SET
       content = excluded.content,
       summary = excluded.summary,
       tags = excluded.tags,
       importance = excluded.importance,
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       embedding_dim = excluded.embedding_dim,
       language = excluded.language,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.workspace,
    input.agent_id ?? null,
    input.type,
    input.title,
    input.content,
    input.summary ?? null,
    input.source,
    input.source_session_id ?? null,
    input.source_file_path ?? null,
    tags,
    input.importance ?? 0.5,
    input.pinned ? 1 : 0,
    blob,
    input.embedding_model ?? null,
    input.embedding_dim ?? null,
    input.language ?? null,
    input.probation_until ?? null,
    now,
    now,
  );

  const row = db
    .prepare(
      `SELECT * FROM memories
       WHERE workspace = ? AND source = ?
         AND COALESCE(source_file_path, '') = COALESCE(?, '')
         AND title = ?`,
    )
    .get(
      input.workspace,
      input.source,
      input.source_file_path ?? null,
      input.title,
    ) as Record<string, unknown> | undefined;

  if (!row) throw new Error("Failed to retrieve upserted memory");
  return parseRow(row);
}

export function getMemoryById(id: string): MemoryRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export function getMemoryEmbedding(id: string): Float32Array | null {
  const db = getDb();
  const row = db
    .prepare("SELECT embedding FROM memories WHERE id = ?")
    .get(id) as { embedding: Buffer | null } | undefined;
  return row ? blobToEmbedding(row.embedding) : null;
}

export function updateMemory(id: string, patch: MemoryUpdate): MemoryRow | null {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(patch.title);
  }
  if (patch.content !== undefined) {
    fields.push("content = ?");
    values.push(patch.content);
  }
  if (patch.summary !== undefined) {
    fields.push("summary = ?");
    values.push(patch.summary);
  }
  if (patch.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(patch.tags));
  }
  if (patch.importance !== undefined) {
    fields.push("importance = ?");
    values.push(patch.importance);
  }
  if (patch.pinned !== undefined) {
    fields.push("pinned = ?");
    values.push(patch.pinned ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    fields.push("archived = ?");
    values.push(patch.archived ? 1 : 0);
  }
  if (patch.probation_until !== undefined) {
    fields.push("probation_until = ?");
    values.push(patch.probation_until);
  }
  if (patch.language !== undefined) {
    fields.push("language = ?");
    values.push(patch.language);
  }

  if (fields.length === 0) return getMemoryById(id);

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );
  return getMemoryById(id);
}

export function setMemoryEmbedding(
  id: string,
  embedding: Float32Array,
  model: string,
  dim: number,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE memories
     SET embedding = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
     WHERE id = ?`,
  ).run(embeddingToBlob(embedding), model, dim, new Date().toISOString(), id);
}

export function recordAccess(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE memories
     SET access_count = access_count + 1, last_accessed_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return info.changes > 0;
}

export interface ListMemoriesOptions {
  workspace?: string;
  agent_id?: string;
  type?: MemoryType | MemoryType[];
  source?: MemorySource;
  pinned?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
  sort?: "created" | "updated" | "importance" | "accessed";
}

export function listMemories(opts: ListMemoriesOptions = {}): {
  memories: MemoryRow[];
  total: number;
} {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.workspace) {
    conditions.push("workspace = ?");
    params.push(opts.workspace);
  }
  if (opts.agent_id) {
    conditions.push("agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts.type) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type];
    conditions.push(`type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  if (opts.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts.pinned !== undefined) {
    conditions.push("pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.archived !== undefined) {
    conditions.push("archived = ?");
    params.push(opts.archived ? 1 : 0);
  }
  if (opts.search && opts.search.trim()) {
    conditions.push("(title LIKE ? OR content LIKE ? OR summary LIKE ?)");
    const like = `%${opts.search.trim()}%`;
    params.push(like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderColumn =
    opts.sort === "importance"
      ? "importance DESC, created_at DESC"
      : opts.sort === "accessed"
      ? "last_accessed_at DESC NULLS LAST, created_at DESC"
      : opts.sort === "updated"
      ? "updated_at DESC"
      : "created_at DESC";

  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM memories ${where}`)
    .get(...params) as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT * FROM memories ${where} ORDER BY ${orderColumn} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return { memories: rows.map(parseRow), total };
}

export interface SimilarityHit {
  memory: MemoryRow;
  score: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface SearchSimilarOptions {
  workspace?: string;
  type?: MemoryType | MemoryType[];
  archived?: boolean;
  excludeIds?: string[];
  k?: number;
  minScore?: number;
}

interface VectorScanRow {
  id: string;
  embedding_dim: number | null;
  embedding: Buffer | null;
}

/**
 * Pure-JS cosine k-NN search. Scans candidate rows that share the
 * query vector's dimensionality, computes similarity, returns top-k.
 *
 * On a single-user instance this comfortably handles up to ~10k
 * vectors at 384 dims in well under 50ms.
 */
export function searchSimilar(
  query: Float32Array,
  opts: SearchSimilarOptions = {},
): SimilarityHit[] {
  const db = getDb();
  const conditions: string[] = [
    "embedding IS NOT NULL",
    "embedding_dim = ?",
  ];
  const params: unknown[] = [query.length];

  if (opts.workspace) {
    conditions.push("workspace = ?");
    params.push(opts.workspace);
  }
  if (opts.type) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type];
    conditions.push(`type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  if (opts.archived === false || opts.archived === undefined) {
    conditions.push("archived = 0");
  }
  if (opts.excludeIds && opts.excludeIds.length > 0) {
    conditions.push(
      `id NOT IN (${opts.excludeIds.map(() => "?").join(",")})`,
    );
    params.push(...opts.excludeIds);
  }

  const rows = db
    .prepare(
      `SELECT id, embedding_dim, embedding
       FROM memories
       WHERE ${conditions.join(" AND ")}`,
    )
    .all(...params) as VectorScanRow[];

  const hits: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    const vec = blobToEmbedding(row.embedding);
    if (!vec) continue;
    const score = cosineSimilarity(query, vec);
    if (opts.minScore !== undefined && score < opts.minScore) continue;
    hits.push({ id: row.id, score });
  }

  hits.sort((a, b) => b.score - a.score);
  const k = Math.min(Math.max(opts.k ?? 10, 1), 100);
  const top = hits.slice(0, k);

  if (top.length === 0) return [];

  const placeholders = top.map(() => "?").join(",");
  const memoryRows = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...top.map((h) => h.id)) as Record<string, unknown>[];
  const byId = new Map(memoryRows.map((r) => [r.id as string, parseRow(r)]));

  return top
    .map((h) => {
      const memory = byId.get(h.id);
      return memory ? { memory, score: h.score } : null;
    })
    .filter((x): x is SimilarityHit => x !== null);
}

export function createLink(
  fromId: string,
  toId: string,
  kind: LinkKind,
  source: MemoryLinkRow["source"],
  weight = 1.0,
): MemoryLinkRow | null {
  if (fromId === toId) return null;
  const db = getDb();
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO memory_links (id, from_id, to_id, kind, weight, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, fromId, toId, kind, weight, source);
  } catch {
    return null; // UNIQUE constraint hit — link already exists
  }
  return {
    id,
    from_id: fromId,
    to_id: toId,
    kind,
    weight,
    source,
    created_at: new Date().toISOString(),
  };
}

export function getLinksFor(id: string): MemoryLinkRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM memory_links WHERE from_id = ? OR to_id = ? ORDER BY weight DESC`,
    )
    .all(id, id) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    from_id: r.from_id as string,
    to_id: r.to_id as string,
    kind: r.kind as LinkKind,
    weight: Number(r.weight),
    source: r.source as MemoryLinkRow["source"],
    created_at: r.created_at as string,
  }));
}

export interface ExtractionCursor {
  session_id: string;
  agent_id: string;
  file_path: string;
  last_line: number;
  last_processed_at: string;
  bytes_seen: number;
}

export function getCursor(sessionId: string): ExtractionCursor | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM extraction_cursors WHERE session_id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    session_id: row.session_id as string,
    agent_id: row.agent_id as string,
    file_path: row.file_path as string,
    last_line: Number(row.last_line),
    last_processed_at: row.last_processed_at as string,
    bytes_seen: Number(row.bytes_seen),
  };
}

export function setCursor(cursor: ExtractionCursor): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO extraction_cursors (session_id, agent_id, file_path, last_line, last_processed_at, bytes_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       file_path = excluded.file_path,
       last_line = excluded.last_line,
       last_processed_at = excluded.last_processed_at,
       bytes_seen = excluded.bytes_seen`,
  ).run(
    cursor.session_id,
    cursor.agent_id,
    cursor.file_path,
    cursor.last_line,
    cursor.last_processed_at,
    cursor.bytes_seen,
  );
}

export function recordFeedback(
  memoryId: string,
  vote: 1 | -1,
  context: string | null,
  query: string | null,
): void {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO memory_feedback (id, memory_id, vote, context, query)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, memoryId, vote, context, query);

  const mem = getMemoryById(memoryId);
  if (!mem) return;
  const delta = vote === 1 ? 0.05 : -0.1;
  const next = Math.min(1, Math.max(0, mem.importance + delta));
  updateMemory(memoryId, { importance: next });
}

export type ExtractorProvider = "openclaw" | "ollama" | "heuristic";

export interface MemorySettings {
  embedding_provider: string;
  embedding_model: string;
  forgetting_threshold: number;
  forgetting_age_days: number;
  inject_into_memory_md: boolean;
  extraction_enabled: boolean;
  extractor_provider: ExtractorProvider;
  ollama_model: string;
  welcome_notification_shown: boolean;
  llm_choice_made: boolean;
  home_lat: number | null;
  home_lon: number | null;
  home_label: string | null;
  home_timezone: string | null;
  home_updated_at: string | null;
  morning_briefing_enabled: boolean;
  elevenlabs_api_key: string | null;
  elevenlabs_voice_id: string | null;
  elevenlabs_model_id: string;
  fishaudio_api_key: string | null;
  fishaudio_voice_id: string | null;
  fishaudio_model: string;
  tts_provider: TtsProvider;
  porcupine_access_key: string | null;
  porcupine_keyword: string;
}

export type TtsProvider = "elevenlabs" | "fishaudio";

const DEFAULT_SETTINGS: MemorySettings = {
  embedding_provider: "xenova",
  embedding_model: "Xenova/all-MiniLM-L6-v2",
  forgetting_threshold: 0.2,
  forgetting_age_days: 90,
  inject_into_memory_md: true,
  extraction_enabled: true,
  extractor_provider: "openclaw",
  ollama_model: "qwen2.5:7b",
  welcome_notification_shown: false,
  llm_choice_made: false,
  home_lat: null,
  home_lon: null,
  home_label: null,
  home_timezone: null,
  home_updated_at: null,
  morning_briefing_enabled: false,
  elevenlabs_api_key: null,
  elevenlabs_voice_id: null,
  elevenlabs_model_id: "eleven_multilingual_v2",
  fishaudio_api_key: null,
  fishaudio_voice_id: null,
  fishaudio_model: "s2-pro",
  tts_provider: "elevenlabs",
  porcupine_access_key: null,
  porcupine_keyword: "Jarvis",
};

function parseNullableFloat(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "null") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function parseNullableString(value: string | undefined): string | null {
  if (value === undefined || value === "" || value === "null") return null;
  return value;
}

function parseExtractorProvider(value: string | undefined): ExtractorProvider {
  if (value === "ollama" || value === "heuristic" || value === "openclaw") {
    return value;
  }
  return DEFAULT_SETTINGS.extractor_provider;
}

function parseTtsProvider(value: string | undefined): TtsProvider {
  return value === "fishaudio" ? "fishaudio" : "elevenlabs";
}

export function getSettings(): MemorySettings {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM memory_settings")
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    embedding_provider:
      map.get("embedding_provider") ?? DEFAULT_SETTINGS.embedding_provider,
    embedding_model:
      map.get("embedding_model") ?? DEFAULT_SETTINGS.embedding_model,
    forgetting_threshold: parseFloat(
      map.get("forgetting_threshold") ??
        String(DEFAULT_SETTINGS.forgetting_threshold),
    ),
    forgetting_age_days: parseInt(
      map.get("forgetting_age_days") ??
        String(DEFAULT_SETTINGS.forgetting_age_days),
      10,
    ),
    inject_into_memory_md:
      (map.get("inject_into_memory_md") ?? "true") === "true",
    extraction_enabled: (map.get("extraction_enabled") ?? "true") === "true",
    extractor_provider: parseExtractorProvider(map.get("extractor_provider")),
    ollama_model: map.get("ollama_model") ?? DEFAULT_SETTINGS.ollama_model,
    welcome_notification_shown:
      (map.get("welcome_notification_shown") ?? "false") === "true",
    llm_choice_made: (map.get("llm_choice_made") ?? "false") === "true",
    home_lat: parseNullableFloat(map.get("home_lat")),
    home_lon: parseNullableFloat(map.get("home_lon")),
    home_label: parseNullableString(map.get("home_label")),
    home_timezone: parseNullableString(map.get("home_timezone")),
    home_updated_at: parseNullableString(map.get("home_updated_at")),
    morning_briefing_enabled: (map.get("morning_briefing_enabled") ?? "false") === "true",
    elevenlabs_api_key: parseNullableString(map.get("elevenlabs_api_key")),
    elevenlabs_voice_id: parseNullableString(map.get("elevenlabs_voice_id")),
    elevenlabs_model_id:
      map.get("elevenlabs_model_id") ?? DEFAULT_SETTINGS.elevenlabs_model_id,
    fishaudio_api_key: parseNullableString(map.get("fishaudio_api_key")),
    fishaudio_voice_id: parseNullableString(map.get("fishaudio_voice_id")),
    fishaudio_model:
      map.get("fishaudio_model") ?? DEFAULT_SETTINGS.fishaudio_model,
    tts_provider: parseTtsProvider(map.get("tts_provider")),
    porcupine_access_key: parseNullableString(map.get("porcupine_access_key")),
    porcupine_keyword:
      map.get("porcupine_keyword") ?? DEFAULT_SETTINGS.porcupine_keyword,
  };
}

export function setSettings(patch: Partial<MemorySettings>): MemorySettings {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO memory_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );
  const tx = db.transaction((entries: Array<[string, string]>) => {
    for (const [k, v] of entries) stmt.run(k, v);
  });
  const entries: Array<[string, string]> = Object.entries(patch).map(
    ([k, v]) => [k, v === null || v === undefined ? "" : String(v)],
  );
  tx(entries);
  return getSettings();
}

export interface MemoryStats {
  total: number;
  archived: number;
  pinned: number;
  byType: Record<MemoryType, number>;
  byWorkspace: Record<string, number>;
  embeddingModel: string | null;
  lastExtractionAt: string | null;
  cursors: number;
}

export function getStats(): MemoryStats {
  const db = getDb();
  const total = (db
    .prepare("SELECT COUNT(*) AS n FROM memories")
    .get() as { n: number }).n;
  const archived = (db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE archived = 1")
    .get() as { n: number }).n;
  const pinned = (db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE pinned = 1")
    .get() as { n: number }).n;

  const typeRows = db
    .prepare(
      "SELECT type, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY type",
    )
    .all() as Array<{ type: string; n: number }>;
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.type] = r.n;

  const wsRows = db
    .prepare(
      "SELECT workspace, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY workspace",
    )
    .all() as Array<{ workspace: string; n: number }>;
  const byWorkspace: Record<string, number> = {};
  for (const r of wsRows) byWorkspace[r.workspace] = r.n;

  const lastModel = (db
    .prepare("SELECT embedding_model FROM memories WHERE embedding_model IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
    .get() as { embedding_model: string } | undefined)?.embedding_model ?? null;

  const lastExtraction = (db
    .prepare(
      "SELECT last_processed_at FROM extraction_cursors ORDER BY last_processed_at DESC LIMIT 1",
    )
    .get() as { last_processed_at: string } | undefined)?.last_processed_at ??
    null;

  const cursors = (db
    .prepare("SELECT COUNT(*) AS n FROM extraction_cursors")
    .get() as { n: number }).n;

  return {
    total,
    archived,
    pinned,
    byType: {
      episodic: byType.episodic ?? 0,
      semantic: byType.semantic ?? 0,
      procedural: byType.procedural ?? 0,
      identity: byType.identity ?? 0,
    },
    byWorkspace,
    embeddingModel: lastModel,
    lastExtractionAt: lastExtraction,
    cursors,
  };
}

export function archiveLowImportance(
  thresholdImportance: number,
  ageDays: number,
): number {
  const db = getDb();
  const cutoff = new Date(
    Date.now() - ageDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const info = db
    .prepare(
      `UPDATE memories
       SET archived = 1, updated_at = datetime('now')
       WHERE archived = 0
         AND pinned = 0
         AND importance < ?
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
         AND access_count < 2`,
    )
    .run(thresholdImportance, cutoff);
  return info.changes;
}

/**
 * Promote (or auto-archive) reflections whose probation has expired
 * without any access / vote. Returns counts.
 */
export function reviewProbationExpired(): {
  promoted: number;
  archived: number;
} {
  const db = getDb();
  const now = new Date().toISOString();

  const promoted = db
    .prepare(
      `UPDATE memories
       SET probation_until = NULL, updated_at = datetime('now')
       WHERE probation_until IS NOT NULL AND probation_until < ?
         AND (pinned = 1 OR access_count > 0)`,
    )
    .run(now);

  const archived = db
    .prepare(
      `UPDATE memories
       SET archived = 1, probation_until = NULL, updated_at = datetime('now')
       WHERE probation_until IS NOT NULL AND probation_until < ?
         AND pinned = 0 AND access_count = 0`,
    )
    .run(now);

  return { promoted: promoted.changes, archived: archived.changes };
}
