import { promises as fs } from "fs";
import path from "path";

/**
 * Indexador das landing pages criadas pelo OpenClaw.
 *
 * As páginas vivem em `public/landing/**` e são servidas pelo Next em
 * `/landing/<relPath>/`. Cada subpasta que contém um HTML de entrada
 * (`index.html`, senão o primeiro `*.html`) é tratada como uma página.
 *
 * Nada de dependências extras: o título/descrição saem por regex simples e a
 * miniatura no front é um <iframe> da própria página (mesma origem).
 */

export const LANDING_DIR = path.join(process.cwd(), "public", "landing");

export type LandingSort = "modified" | "created" | "title";

export interface LandingPage {
  /** Caminho relativo a `public/landing`, com barras normais. Ex: "pizzaria" ou "promos/natal". */
  relPath: string;
  /** URL pública servida pelo Next. Ex: "/landing/pizzaria/". */
  url: string;
  /** Arquivo de entrada relativo a `public/landing`. Ex: "pizzaria/index.html". */
  entryFile: string;
  title: string;
  description: string;
  createdAt: number;
  modifiedAt: number;
  sizeBytes: number;
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

  return {
    relPath,
    // Aponta para o arquivo de entrada (com extensão) de propósito: o middleware
    // do AtlasDeck (proxy.ts) só libera assets públicos quando o path tem ponto;
    // `/landing/<pasta>/` redirecionaria para /login. `/landing/<pasta>/index.html`
    // é servido direto como estático.
    url: `/landing/${entryFile}`,
    entryFile,
    title: extractTitle(html, relPath),
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

  async function walk(relDir: string) {
    const dirAbs = path.join(LANDING_DIR, relDir);
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    // Esta pasta é uma página?
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

  // Confirma que o diretório base existe antes de varrer.
  try {
    const st = await fs.stat(LANDING_DIR);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  await walk("");
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
