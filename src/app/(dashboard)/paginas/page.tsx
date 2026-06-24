"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, LayoutGrid, FolderTree } from "lucide-react";
import { LandingCard } from "@/components/Landing/LandingCard";
import type { LandingPage, LandingSort } from "@/lib/landing-index";

const SORTS: Array<{ key: LandingSort; label: string }> = [
  { key: "modified", label: "Modificação" },
  { key: "created", label: "Criação" },
  { key: "title", label: "Título" },
];

/** Valores especiais do filtro de pasta. */
const FOLDER_ALL = "__all__";
const FOLDER_ROOT = "__root__";

export default function LandingPagesPage() {
  const [pages, setPages] = useState<LandingPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LandingSort>("modified");
  const [folder, setFolder] = useState<string>(FOLDER_ALL);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/landing?sort=${sort}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar páginas");
      setPages(data.pages || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  // Pastas existentes (primeiro segmento das páginas aninhadas), auto-detectadas.
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const p of pages) if (p.folder) set.add(p.folder);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [pages]);

  const hasRootPages = useMemo(() => pages.some((p) => !p.folder), [pages]);

  // Reseta o filtro se a pasta selecionada deixar de existir após um refresh.
  useEffect(() => {
    if (folder === FOLDER_ALL) return;
    if (folder === FOLDER_ROOT) {
      if (!hasRootPages) setFolder(FOLDER_ALL);
      return;
    }
    if (!folders.includes(folder)) setFolder(FOLDER_ALL);
  }, [folders, hasRootPages, folder]);

  const filtered = useMemo(() => {
    let list = pages;
    if (folder === FOLDER_ROOT) {
      list = list.filter((p) => !p.folder);
    } else if (folder !== FOLDER_ALL) {
      list = list.filter((p) => p.folder === folder);
    }
    const term = query.trim().toLowerCase();
    if (term) {
      list = list.filter((p) =>
        `${p.title} ${p.description} ${p.relPath}`.toLowerCase().includes(term),
      );
    }
    return list;
  }, [pages, query, folder]);

  const handleDelete = async (page: LandingPage) => {
    if (!confirm(`Excluir a página "${page.title}"? Isso apaga a pasta ${page.relPath}.`)) return;
    try {
      const res = await fetch(`/api/landing?path=${encodeURIComponent(page.relPath)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao excluir");
      }
      setPages((prev) => prev.filter((p) => p.relPath !== page.relPath));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold mb-1 flex items-center gap-2"
            style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)", letterSpacing: "-1px" }}
          >
            <LayoutGrid className="w-6 h-6" style={{ color: "var(--accent)" }} />
            Páginas
          </h1>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {filtered.length} de {pages.length} landing pages
            {folder === FOLDER_ROOT
              ? " na raiz"
              : folder !== FOLDER_ALL
                ? <> na pasta <code>{folder}</code></>
                : null}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
          >
            <Search className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por título, descrição ou caminho..."
              className="bg-transparent outline-none text-sm w-64 max-w-[60vw]"
              style={{ color: "var(--text-primary)" }}
            />
          </div>

          {folders.length > 0 && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              <FolderTree className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
              <select
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                className="bg-transparent outline-none text-sm cursor-pointer"
                style={{ color: "var(--text-primary)" }}
                title="Filtrar por pasta"
              >
                <option value={FOLDER_ALL}>Todas as pastas</option>
                {hasRootPages && <option value={FOLDER_ROOT}>Raiz (sem pasta)</option>}
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            className="flex items-center rounded-lg overflow-hidden"
            style={{ border: "1px solid var(--border)" }}
          >
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSort(s.key)}
                className="px-3 py-2 text-xs font-medium transition-all"
                style={{
                  backgroundColor: sort === s.key ? "var(--accent)" : "var(--card)",
                  color: sort === s.key ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Atualizar
          </button>
        </div>
      </div>

      {error && (
        <div
          className="p-4 rounded-lg text-sm"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--error)", color: "var(--error)" }}
        >
          {error}
        </div>
      )}

      {!loading && !error && pages.length === 0 && (
        <div
          className="p-10 rounded-xl text-center"
          style={{ backgroundColor: "var(--card)", border: "1px dashed var(--border)" }}
        >
          <LayoutGrid className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            Nenhuma página em <code>/landing</code> ainda
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Quando o OpenClaw criar landing pages em <code>public/landing</code>, elas aparecem aqui.
          </p>
        </div>
      )}

      {!error && (filtered.length > 0 || loading) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((page) => (
            <LandingCard key={page.relPath} page={page} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {!loading && !error && pages.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>
          Nenhuma página corresponde a “{query}”.
        </div>
      )}
    </div>
  );
}
