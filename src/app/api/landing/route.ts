import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { hasValidServiceToken } from "@/lib/openclaw-auth";
import {
  LANDING_DIR,
  scanLandingPages,
  sortPages,
  filterPages,
  type LandingSort,
} from "@/lib/landing-index";

export const dynamic = "force-dynamic";

/**
 * Auth gate. Esta rota é pública na camada de middleware (proxy.ts) para que o
 * bot do OpenClaw — que não tem o cookie admin — consiga listar as páginas pelo
 * comando /paginas. Ela se auto-protege aqui aceitando:
 *   - service token (gateway.auth.token / OPENCLAW_SERVICE_TOKEN), via header
 *     `x-openclaw-token`, usado pelo OpenClaw; OU
 *   - o cookie admin, usado pelo dashboard.
 */
function isAuthorized(request: NextRequest): boolean {
  if (hasValidServiceToken(request)) return true;
  const cookie = request.cookies.get("mc_auth");
  if (cookie && process.env.AUTH_SECRET && cookie.value === process.env.AUTH_SECRET) {
    return true;
  }
  return false;
}

function parseSort(value: string | null): LandingSort {
  if (value === "created" || value === "title" || value === "modified") {
    return value;
  }
  return "modified";
}

/** Base pública para os links (Telegram precisa de URL absoluta clicável). */
function publicBase(request: NextRequest): string {
  const env = process.env.ATLAS_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

function formatDatePt(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || undefined;
  const sort = parseSort(searchParams.get("sort"));
  const format = searchParams.get("format");

  try {
    const all = await scanLandingPages();
    const pages = sortPages(filterPages(all, q), sort);

    if (format === "telegram") {
      const base = publicBase(request);
      const text = pages.length
        ? [
            `📄 *Páginas criadas* (${pages.length})`,
            "",
            ...pages.map((p, i) => {
              const desc = p.description ? ` — ${p.description}` : "";
              return `${i + 1}. *${p.title}*${desc}\n${base}${p.url}\n_atualizada em ${formatDatePt(p.modifiedAt)}_`;
            }),
          ].join("\n")
        : "Nenhuma página encontrada em /landing ainda.";

      return new NextResponse(text, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return NextResponse.json({ pages, total: pages.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Resolve um caminho relativo confinado dentro de LANDING_DIR (anti path traversal). */
function resolveInsideLanding(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(LANDING_DIR, normalized);
  const root = path.resolve(LANDING_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (abs === root) return null;
  return abs;
}

export async function DELETE(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const rel = searchParams.get("path");
  if (!rel) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  const abs = resolveInsideLanding(rel);
  if (!abs) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await fs.rm(abs, { recursive: true, force: true });
    return NextResponse.json({ deleted: true, path: rel });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
