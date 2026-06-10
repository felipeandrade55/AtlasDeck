"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { MessageSquare, Pin, Plus, Search, Trash2 } from "lucide-react";
import type { ChatThread, AgentSummary } from "./types";

interface ThreadListProps {
  threads: ChatThread[];
  activeId: string | null;
  agents: AgentSummary[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onPin: (thread: ChatThread) => void;
  onDelete: (thread: ChatThread) => void;
  /** On mobile the list becomes a slide-over drawer instead of a fixed column. */
  isMobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}

export function ThreadList({
  threads,
  activeId,
  agents,
  onSelect,
  onCreate,
  onPin,
  onDelete,
  isMobile = false,
  open = false,
  onClose,
}: ThreadListProps) {
  const [query, setQuery] = useState("");

  // On mobile, picking or creating a thread should dismiss the drawer.
  const handleSelect = (id: string) => {
    onSelect(id);
    if (isMobile) onClose?.();
  };
  const handleCreate = () => {
    onCreate();
    if (isMobile) onClose?.();
  };

  const agentById = useMemo(() => {
    const map = new Map<string, AgentSummary>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const filtered = useMemo(() => {
    if (!query.trim()) return threads;
    const q = query.toLowerCase();
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, query]);

  const aside = (
    <aside style={isMobile ? mobileContainerStyle(open) : containerStyle}>
      <div style={headerStyle}>
        <button type="button" onClick={handleCreate} style={newButtonStyle}>
          <Plus size={16} />
          Nova conversa
        </button>
      </div>

      <div style={searchWrapStyle}>
        <Search size={14} style={{ color: "var(--text-muted)" }} />
        <input
          type="search"
          placeholder="Buscar conversas..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={searchInputStyle}
        />
      </div>

      <div style={listStyle}>
        {filtered.length === 0 && (
          <div style={emptyStyle}>
            <MessageSquare size={20} />
            <span>Nenhuma conversa</span>
          </div>
        )}
        {filtered.map((thread) => {
          const isActive = thread.id === activeId;
          const agent = agentById.get(thread.agent_id);
          return (
            // div[role=button] em vez de <button>: os botões de fixar/excluir
            // ficam DENTRO do item, e <button> aninhado em <button> é HTML
            // inválido — o React 19 descarta o DOM inteiro na hidratação e
            // remonta a página, apagando estado em progresso.
            <div
              key={thread.id}
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(thread.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelect(thread.id);
                }
              }}
              style={threadItemStyle(isActive)}
            >
              <div style={threadHeaderStyle}>
                <span style={threadTitleStyle}>
                  {thread.pinned && <Pin size={11} />}
                  {agent && (
                    <span style={{ marginRight: 4 }}>{agent.emoji}</span>
                  )}
                  {thread.title}
                </span>
              </div>
              <div style={threadMetaStyle}>
                <span>{thread.message_count} msgs</span>
                <span>
                  {thread.last_message_at
                    ? formatRel(thread.last_message_at)
                    : formatRel(thread.created_at)}
                </span>
              </div>
              <div style={threadActionsStyle}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPin(thread);
                  }}
                  title={thread.pinned ? "Desafixar" : "Fixar"}
                  style={iconBtnStyle}
                >
                  <Pin size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Excluir esta conversa?")) onDelete(thread);
                  }}
                  title="Excluir"
                  style={iconBtnStyle}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );

  if (!isMobile) return aside;

  // Mobile: render the drawer above a tap-to-dismiss backdrop.
  return (
    <>
      <div
        onClick={onClose}
        aria-hidden={!open}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.55)",
          zIndex: 35,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />
      {aside}
    </>
  );
}

function formatRel(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return date.toLocaleDateString("pt-BR");
}

const containerStyle: CSSProperties = {
  width: 280,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--border)",
  background: "var(--bg)",
  height: "100%",
};

function mobileContainerStyle(open: boolean): CSSProperties {
  return {
    position: "fixed",
    top: 48, // below the app top bar
    left: 0,
    bottom: 0,
    width: "min(85vw, 320px)",
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--border)",
    background: "var(--bg)",
    zIndex: 40,
    transform: open ? "translateX(0)" : "translateX(-100%)",
    transition: "transform 0.25s ease",
  };
}

const headerStyle: CSSProperties = {
  padding: 12,
  borderBottom: "1px solid var(--border)",
};

const newButtonStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
  fontWeight: 500,
};

const searchWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--text-primary)",
  fontSize: 13,
};

const listStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 13,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
};

function threadItemStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 10px",
    borderRadius: 8,
    background: active ? "var(--accent-soft)" : "transparent",
    border: active ? "1px solid var(--accent)" : "1px solid transparent",
    cursor: "pointer",
    textAlign: "left",
    color: "var(--text-primary)",
  };
}

const threadHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const threadTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  gap: 4,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const threadMetaStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 11,
  color: "var(--text-muted)",
};

const threadActionsStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  position: "absolute",
  right: 6,
  top: 6,
  opacity: 0,
  transition: "opacity 150ms",
};

const iconBtnStyle: CSSProperties = {
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};
