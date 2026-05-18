"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, FileText, Zap, Calendar, X } from "lucide-react";

interface SearchResult {
  type: "memory" | "activity" | "task";
  title: string;
  snippet: string;
  path?: string;
  timestamp?: string;
}

const typeConfig = {
  memory: { icon: FileText, color: "#3B82F6", bg: "rgba(59, 130, 246, 0.1)" },
  activity: { icon: Zap, color: "var(--accent)", bg: "rgba(255, 59, 48, 0.1)" },
  task: { icon: Calendar, color: "#A855F7", bg: "rgba(168, 85, 247, 0.1)" },
};

interface GlobalSearchProps {
  fullPage?: boolean;
}

export function GlobalSearch({ fullPage = false }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const searchDebounced = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data);
    } catch {
      setResults([]);
    }
    setIsSearching(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchDebounced(query), 300);
    return () => clearTimeout(timer);
  }, [query, searchDebounced]);

  return (
    <div className={fullPage ? "" : "relative"}>
      {/* Search Input */}
      <div className="relative">
        <Search 
          className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5" 
          style={{ color: "var(--text-secondary)" }} 
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar atividades, tarefas e documentos..."
          className="w-full pl-12 pr-10 py-3 rounded-xl transition-colors focus:outline-none"
          style={{ 
            backgroundColor: "var(--card)", 
            color: "var(--text-primary)", 
            border: "1px solid var(--border)" 
          }}
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Results */}
      {(query.length >= 2 || results.length > 0) && (
        <div
          className={`${
            fullPage
              ? "mt-6 rounded-xl"
              : "absolute top-full left-0 right-0 mt-2 rounded-xl shadow-xl z-50 max-h-96 overflow-y-auto"
          }`}
          style={{ backgroundColor: "var(--card)" }}
        >
          {isSearching && (
            <div className="p-4 text-center" style={{ color: "var(--text-secondary)" }}>
              Buscando...
            </div>
          )}

          {!isSearching && results.length === 0 && query.length >= 2 && (
            <div className="p-8 text-center" style={{ color: "var(--text-secondary)" }}>
              <Search className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>Nenhum resultado encontrado para &quot;{query}&quot;</p>
            </div>
          )}

          {!isSearching && results.length > 0 && (
            <div>
              {results.map((result, index) => {
                const config = typeConfig[result.type];
                const Icon = config.icon;

                return (
                  <div
                    key={index}
                    className="p-4 transition-colors cursor-pointer"
                    style={{ 
                      borderBottom: index < results.length - 1 ? "1px solid var(--border)" : "none" 
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div 
                        className="p-2 rounded-lg"
                        style={{ backgroundColor: config.bg }}
                      >
                        <Icon className="w-4 h-4" style={{ color: config.color }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                            {result.title}
                          </span>
                          <span
                            className="text-xs px-2 py-0.5 rounded"
                            style={{ backgroundColor: config.bg, color: config.color }}
                          >
                            {result.type}
                          </span>
                        </div>
                        <p 
                          className="text-sm line-clamp-2"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {result.snippet}
                        </p>
                        {result.path && (
                          <p 
                            className="text-xs mt-1 truncate"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {result.path}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
