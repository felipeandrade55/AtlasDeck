"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Brain, Pin, Archive, Trash2, ThumbsUp, ThumbsDown, Search, Plus, X } from "lucide-react";
import { useToast } from "@/components/Toast";

export type MemoryType = "episodic" | "semantic" | "procedural" | "identity";

export interface Memory {
  id: string;
  workspace: string;
  agent_id: string | null;
  type: MemoryType;
  title: string;
  content: string;
  summary: string | null;
  source: string;
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

interface MemoryListProps {
  workspace: string;
}

const TYPE_LABELS: Record<MemoryType, string> = {
  episodic: "Episódica",
  semantic: "Semântica",
  procedural: "Procedural",
  identity: "Identidade",
};

const TYPE_COLORS: Record<MemoryType, string> = {
  identity: "#FF3B30",
  semantic: "#0A84FF",
  procedural: "#32D74B",
  episodic: "#FFD60A",
};

export function MemoryList({ workspace }: MemoryListProps) {
  const toast = useToast();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<MemoryType | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"semantic" | "keyword">(
    "semantic",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<Memory[] | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        workspace,
        sort: "importance",
        limit: "200",
      });
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (showArchived) params.set("archived", "true");
      else params.set("archived", "false");
      if (pinnedOnly) params.set("pinned", "true");
      const res = await fetch(`/api/memory/list?${params.toString()}`);
      if (!res.ok) throw new Error("Falha ao listar memórias");
      const data = await res.json();
      setMemories(data.memories ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Falha");
    } finally {
      setLoading(false);
    }
  }, [workspace, typeFilter, showArchived, pinnedOnly]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounced semantic search
  useEffect(() => {
    if (!query || query.length < 2) {
      setSearchHits(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        if (searchMode === "semantic") {
          const params = new URLSearchParams({ workspace, q: query, k: "20" });
          const res = await fetch(
            `/api/memory/semantic-search?${params.toString()}`,
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.hint || data?.error || "Falha");
          }
          const data = await res.json();
          setSearchHits(
            (data.results ?? []).map((r: { memory: Memory }) => r.memory),
          );
        } else {
          const params = new URLSearchParams({ workspace, q: query, limit: "20", sort: "importance" });
          const res = await fetch(`/api/memory/list?${params.toString()}`);
          if (!res.ok) throw new Error("Falha");
          const data = await res.json();
          setSearchHits(data.memories ?? []);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Busca falhou");
        setSearchHits([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, workspace, searchMode, toast]);

  const shown = searchHits ?? memories;
  const selected = useMemo(
    () => shown.find((m) => m.id === selectedId) ?? null,
    [shown, selectedId],
  );

  const refreshAfterMutation = useCallback(() => {
    setSearchHits(null);
    load();
  }, [load]);

  const togglePin = async (m: Memory) => {
    try {
      const res = await fetch(`/api/memory/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: !m.pinned }),
      });
      if (!res.ok) throw new Error("Falha");
      toast.success(m.pinned ? "Memória despinada" : "Memória pinada");
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  const toggleArchive = async (m: Memory) => {
    try {
      const res = await fetch(`/api/memory/${m.id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !m.archived }),
      });
      if (!res.ok) throw new Error("Falha");
      toast.success(m.archived ? "Memória restaurada" : "Memória arquivada");
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  const remove = async (m: Memory) => {
    if (!window.confirm(`Excluir "${m.title}" definitivamente?`)) return;
    try {
      const res = await fetch(`/api/memory/${m.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Falha");
      toast.success("Memória excluída");
      if (selectedId === m.id) setSelectedId(null);
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  const vote = async (m: Memory, value: 1 | -1) => {
    try {
      const res = await fetch(`/api/memory/${m.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote: value, context: "ui" }),
      });
      if (!res.ok) throw new Error("Falha");
      toast.success(value === 1 ? "👍 importance aumentada" : "👎 importance reduzida");
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  const create = async () => {
    const title = window.prompt("Título da memória:");
    if (!title) return;
    const content = window.prompt("Conteúdo:");
    if (!content) return;
    const type =
      (window.prompt(
        "Tipo (episodic/semantic/procedural/identity):",
        "semantic",
      ) || "semantic") as MemoryType;
    try {
      const res = await fetch("/api/memory/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, type, title, content, importance: 0.6 }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Falha");
      }
      toast.success("Memória criada");
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
      {/* Sidebar with filters + list */}
      <div
        style={{
          width: 380,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {/* Top toolbar */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ position: "relative" }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 8,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
              }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar memórias…"
              style={{
                width: "100%",
                padding: "6px 26px 6px 28px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Limpar busca"
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  padding: 2,
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as MemoryType | "all")}
              style={selectStyle}
            >
              <option value="all">Todos os tipos</option>
              <option value="identity">Identidade</option>
              <option value="semantic">Semânticas</option>
              <option value="procedural">Procedurais</option>
              <option value="episodic">Episódicas</option>
            </select>
            <select
              value={searchMode}
              onChange={(e) => setSearchMode(e.target.value as "semantic" | "keyword")}
              style={selectStyle}
              title="Modo de busca"
            >
              <option value="semantic">Semântica</option>
              <option value="keyword">Keyword</option>
            </select>
            <button
              type="button"
              onClick={() => setPinnedOnly((v) => !v)}
              style={{ ...chipStyle, background: pinnedOnly ? "var(--accent)" : "var(--bg)", color: pinnedOnly ? "var(--bg)" : "var(--text-primary)" }}
              title="Mostrar apenas pinadas"
            >
              <Pin size={11} /> Pinadas
            </button>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              style={{ ...chipStyle, background: showArchived ? "var(--accent)" : "var(--bg)", color: showArchived ? "var(--bg)" : "var(--text-primary)" }}
              title="Mostrar arquivadas"
            >
              <Archive size={11} /> Arquivadas
            </button>
            <button type="button" onClick={create} style={chipStyle} title="Criar memória manualmente">
              <Plus size={11} /> Nova
            </button>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {searchHits ? `${shown.length} resultado(s)` : `${total} memória(s)`}
          </div>
        </div>

        {/* List */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}>
              Carregando…
            </div>
          ) : error ? (
            <div style={{ padding: 20, color: "var(--error, #FF453A)", fontSize: 13 }}>
              {error}
            </div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}>
              {query
                ? "Nenhuma memória corresponde à busca."
                : "Nenhuma memória ainda neste workspace. Use a aba Configurações → Importar markdown ou Extrair sessões."}
            </div>
          ) : (
            shown.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedId(m.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background:
                    m.id === selectedId
                      ? "var(--accent-soft, rgba(255,59,48,0.08))"
                      : "transparent",
                  cursor: "pointer",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: TYPE_COLORS[m.type],
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.title}
                  </span>
                  {m.pinned && (
                    <Pin
                      size={11}
                      style={{ color: "var(--accent)", flexShrink: 0 }}
                    />
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.summary || m.content.slice(0, 80)}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    marginTop: 4,
                    display: "flex",
                    gap: 8,
                  }}
                >
                  <span>{TYPE_LABELS[m.type]}</span>
                  <span>·</span>
                  <span>importance {(m.importance * 100).toFixed(0)}%</span>
                  {m.access_count > 0 && (
                    <>
                      <span>·</span>
                      <span>acesso {m.access_count}×</span>
                    </>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>
        {selected ? (
          <div style={{ maxWidth: 720, marginInline: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: TYPE_COLORS[selected.type],
                  color: "var(--bg)",
                  fontWeight: 600,
                }}
              >
                {TYPE_LABELS[selected.type]}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {selected.source} · importance {(selected.importance * 100).toFixed(0)}%
              </span>
              {selected.pinned && (
                <span style={{ fontSize: 11, color: "var(--accent)" }}>📌 pinada</span>
              )}
              {selected.archived && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>arquivada</span>
              )}
            </div>

            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: 22,
                fontWeight: 700,
                marginBottom: 8,
                color: "var(--text-primary)",
                letterSpacing: "-0.5px",
              }}
            >
              {selected.title}
            </h2>

            {selected.summary && (
              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
                {selected.summary}
              </p>
            )}

            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 16,
                fontSize: 13,
                fontFamily: "var(--font-body)",
                color: "var(--text-primary)",
                lineHeight: 1.6,
              }}
            >
              {selected.content}
            </pre>

            {selected.tags.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {selected.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "var(--bg)",
                      color: "var(--text-secondary)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => vote(selected, 1)} style={iconButtonStyle} title="Aumentar importance">
                <ThumbsUp size={13} /> Útil
              </button>
              <button type="button" onClick={() => vote(selected, -1)} style={iconButtonStyle} title="Reduzir importance">
                <ThumbsDown size={13} /> Não útil
              </button>
              <button type="button" onClick={() => togglePin(selected)} style={iconButtonStyle}>
                <Pin size={13} /> {selected.pinned ? "Despinar" : "Pinar"}
              </button>
              <button type="button" onClick={() => toggleArchive(selected)} style={iconButtonStyle}>
                <Archive size={13} /> {selected.archived ? "Restaurar" : "Arquivar"}
              </button>
              <button
                type="button"
                onClick={() => remove(selected)}
                style={{ ...iconButtonStyle, color: "var(--error, #FF453A)" }}
              >
                <Trash2 size={13} /> Excluir
              </button>
            </div>

            <div style={{ marginTop: 24, fontSize: 11, color: "var(--text-muted)" }}>
              {selected.source_file_path && (
                <div>Origem: {selected.source_file_path}</div>
              )}
              {selected.source_session_id && (
                <div>Sessão: {selected.source_session_id}</div>
              )}
              <div>Criada em {new Date(selected.created_at).toLocaleString("pt-BR")}</div>
              <div>Atualizada em {new Date(selected.updated_at).toLocaleString("pt-BR")}</div>
              {selected.embedding_model && (
                <div>Embedding: {selected.embedding_model} ({selected.embedding_dim} dim)</div>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            <Brain size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
            <p>Selecione uma memória para ver detalhes</p>
          </div>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 12,
  outline: "none",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
};

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
};
