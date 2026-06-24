import { promises as fs } from "fs";
import path from "path";

/**
 * Indexador das landing pages criadas pelo OpenClaw.
 *
 * As páginas NÃO ficam em public/landing do AtlasDeck. Elas vivem em
 * /root/.openclaw/workspace/dashboard/landing/ e são servidas pelo
 * jarvis-dashboard (porta 8080), com nginx roteando /landing/* para ele.
 *
 * O LANDING_DIR é configurável via env LANDING_DIR (produção aponta para
 * /root/.openclaw/workspace/dashboard/landing; dev local pode usar qualquer
 * pasta de teste). A URL pública usa ATLAS_PUBLIC_URL como base.
 */

export const LANDING_DIR =
  process.env.LANDING_DIR ||
  path.join(process.cwd(), "public", "landing");

export type LandingSort = "modified" | "created" | "title";

export interface LandingPage {
  /** Caminho relativo a `public/landing`, com barras normais. Ex: "pizzaria" ou "promos/natal". */
  relPath: string;
  /** URL pública servida pelo Next. Ex: "/landing/pizzaria/". */
  url: string;
  /** Arquivo de entrada relativo a `public/landing`. Ex: "pizzaria/index.html". */
  entryFile: string;
  /**
   * Pasta de agrupamento (primeiro segmento do caminho quando a página está
   * aninhada). Ex: "wiki/painel" → "wiki". Páginas direto na raiz → "" (sem
   * pasta). Usado pelo filtro de pasta no catálogo.
   */
  folder: string;
  title: string;
  description: string;
  createdAt: number;
  modifiedAt: number;
  sizeBytes: number;
  /**
   * `true` quando a página exige autenticação (HTTP 401/403) — detectado por
   * probe HTTP. O catálogo não carrega o iframe dessas páginas (evita o popup
   * de login do navegador); o link "Abrir" continua funcionando normalmente.
   */
  protected?: boolean;
}

const HTML_ENTRY = "index.html";

function humanizeSlug(slug: string): string {
  const base = slug.split("/").pop() || slug;
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(s: string): string {
  return decodeEntities(s.replace(/\s+/g, " ").trim());
}

function extractTitle(html: string, slug: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && clean(title[1])) return clean(title[1]);

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = clean(h1[1].replace(/<[^>]+>/g, " "));
    if (text) return text;
  }

  return humanizeSlug(slug);
}

function extractDescription(html: string): string {
  const meta = html.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  ) || html.match(
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i,
  );
  if (meta && clean(meta[1])) return clean(meta[1]);

  const og = html.match(
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );
  if (og && clean(og[1])) return clean(og[1]);

  // Fallback: primeiro parágrafo curto, sem tags.
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (p) {
    const text = clean(p[1].replace(/<[^>]+>/g, " "));
    if (text) return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  }

  return "";
}

async function findEntryFile(dirAbs: string): Promise<string | null> {
  const indexAbs = path.join(dirAbs, HTML_ENTRY);
  try {
    const st = await fs.stat(indexAbs);
    if (st.isFile()) return HTML_ENTRY;
  } catch {
    // sem index.html, procura o primeiro *.html
  }

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }

  const html = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
    .map((e) => e.name)
    .sort();

  return html[0] ?? null;
}

async function buildPage(relDir: string): Promise<LandingPage | null> {
  const dirAbs = path.join(LANDING_DIR, relDir);
  const entry = await findEntryFile(dirAbs);
  if (!entry) return null;

  const entryAbs = path.join(dirAbs, entry);
  const stat = await fs.stat(entryAbs);

  let html = "";
  try {
    html = await fs.readFile(entryAbs, "utf-8");
  } catch {
    html = "";
  }

  const relPath = relDir.split(path.sep).join("/");
  const entryFile = `${relPath}/${entry}`;
  // O jarvis-dashboard (porta 8080) serve diretórios normalmente com barra final.
  // Usamos a URL de diretório (/landing/<pasta>/) quando o entry é index.html,
  // e a URL do arquivo quando é qualquer outro HTML (ex: admin.html, main.html).
  const url = entry === HTML_ENTRY
    ? `/landing/${relPath}/`
    : `/landing/${entryFile}`;

  return {
    relPath,
    url,
    entryFile,
    folder: folderOf(relPath),
    title: extractTitle(html, relPath),
    description: extractDescription(html),
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    modifiedAt: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

/**
 * Pasta de agrupamento de uma página: o primeiro segmento quando o caminho é
 * aninhado (ex: "wiki/painel" → "wiki"), ou "" para páginas na raiz de landing.
 */
function folderOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/");
  const idx = norm.indexOf("/");
  return idx > 0 ? norm.slice(0, idx) : "";
}

/** Trata um arquivo HTML direto na raiz de LANDING_DIR como uma página. */
async function buildRootFile(filename: string): Promise<LandingPage | null> {
  const fileAbs = path.join(LANDING_DIR, filename);
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(fileAbs);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  let html = "";
  try {
    html = await fs.readFile(fileAbs, "utf-8");
  } catch {
    html = "";
  }

  const slug = filename.replace(/\.html?$/i, "");

  return {
    relPath: filename,
    url: `/landing/${filename}`,
    entryFile: filename,
    folder: "",
    title: extractTitle(html, slug),
    description: extractDescription(html),
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    modifiedAt: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

/**
 * Percorre `public/landing` recursivamente e devolve uma página por subpasta
 * que tenha um HTML de entrada. Subpastas usadas só como assets (sem HTML)
 * são ignoradas como páginas, mas continuam sendo varridas em profundidade.
 */
export async function scanLandingPages(): Promise<LandingPage[]> {
  const pages: LandingPage[] = [];

  // Confirma que o diretório base existe antes de varrer.
  try {
    const st = await fs.stat(LANDING_DIR);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  // Lê o nível raiz uma vez para detectar: arquivos HTML soltos + subpastas.
  let rootEntries: import("fs").Dirent[];
  try {
    rootEntries = await fs.readdir(LANDING_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  // Arquivos HTML diretos na raiz (ex: as268011-netfacil.html).
  for (const e of rootEntries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
      const page = await buildRootFile(e.name);
      if (page) pages.push(page);
    }
  }

  // Subpastas: cada uma pode ser uma página (com index.html ou outro .html).
  async function walk(relDir: string) {
    const dirAbs = path.join(LANDING_DIR, relDir);
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    if (relDir) {
      const page = await buildPage(relDir);
      if (page) pages.push(page);
    }

    for (const e of entries) {
      if (e.isDirectory()) {
        await walk(relDir ? path.join(relDir, e.name) : e.name);
      }
    }
  }

  for (const e of rootEntries) {
    if (e.isDirectory()) {
      await walk(e.name);
    }
  }

  return pages;
}

export function sortPages(
  pages: LandingPage[],
  by: LandingSort = "modified",
): LandingPage[] {
  const sorted = [...pages];
  switch (by) {
    case "created":
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
      break;
    case "modified":
    default:
      sorted.sort((a, b) => b.modifiedAt - a.modifiedAt);
      break;
  }
  return sorted;
}

export function filterPages(pages: LandingPage[], q?: string): LandingPage[] {
  const term = (q || "").trim().toLowerCase();
  if (!term) return pages;
  return pages.filter((p) =>
    `${p.title} ${p.description} ${p.relPath}`.toLowerCase().includes(term),
  );
}

// ─── Detecção de páginas protegidas (HTTP 401/403) ──────────────────────────
//
// Algumas páginas em /landing são servidas atrás de autenticação (ex.: a
// "Wiki Telecom - Acesso restrito" devolve 401 Basic Auth). Quando o catálogo
// monta o iframe da miniatura dessas páginas, o navegador abre o popup nativo
// de login. Para evitar isso, sondamos cada página por HTTP (HEAD) usando a
// base pública (ATLAS_PUBLIC_URL) e marcamos `protected`. O card então mostra
// um cadeado em vez do iframe — o link "Abrir" continua pedindo login só quando
// o usuário realmente acessa a página.

interface ProbeEntry {
  isProtected: boolean;
  ts: number;
}

const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4000;
const probeCache = new Map<string, ProbeEntry>();

async function probeProtected(fullUrl: string): Promise<boolean> {
  const now = Date.now();
  const cached = probeCache.get(fullUrl);
  if (cached && now - cached.ts < PROBE_TTL_MS) return cached.isProtected;

  let isProtected = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(fullUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    isProtected = res.status === 401 || res.status === 403;
  } catch {
    // Timeout ou erro de rede: não bloqueia a miniatura (assume acessível).
    isProtected = false;
  }

  probeCache.set(fullUrl, { isProtected, ts: now });
  return isProtected;
}

/**
 * Anota `protected` em cada página sondando a URL pública. Sem ATLAS_PUBLIC_URL
 * configurada, não há como sondar de forma confiável — nesse caso assumimos que
 * tudo é acessível (comportamento anterior) e não marcamos nada.
 */
export async function annotateProtection(
  pages: LandingPage[],
): Promise<LandingPage[]> {
  const base = (process.env.ATLAS_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!base) return pages;

  await Promise.all(
    pages.map(async (p) => {
      p.protected = await probeProtected(`${base}${p.url}`);
    }),
  );
  return pages;
}
