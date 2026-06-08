"use client";

/**
 * Detail panel for a selected memory node. On desktop it's a right-side aside;
 * on mobile it slides up as a bottom sheet. Pulls the full memory (summary,
 * tags…) from /api/memory/[id] and the enriched connections from
 * /api/memory/links/[id]; clicking a connection focuses that node in the graph.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Pin, ArrowUpRight, Loader2 } from "lucide-react";
import type { MemoryType, LinkKind } from "@/lib/memory-db";
import {
  TYPE_COLORS,
  TYPE_LABELS,
  LINK_KIND_LABELS,
} from "@/lib/graph-theme";
import type { GraphNode } from "./MemoryGraphCanvas";

interface MemoryDetail {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  type: MemoryType;
  tags: string[];
  importance: number;
  pinned: boolean;
  created_at: string;
}

interface Connection {
  link: { kind: LinkKind; weight: number };
  memory: { id: string; title: string; type: MemoryType; importance: number };
}

interface Props {
  node: GraphNode;
  onClose: () => void;
  onNavigate: (id: string) => void;
  isMobile: boolean;
}

export function NodeDetailPanel({ node, onClose, onNavigate, isMobile }: Props) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // Trigger slide-in after mount.
    const t = setTimeout(() => setEntered(true), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setConnections([]);
    (async () => {
      try {
        const [mRes, lRes] = await Promise.all([
          fetch(`/api/memory/${node.id}`, { cache: "no-store" }),
          fetch(`/api/memory/links/${node.id}`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (mRes.ok) {
          const json = await mRes.json();
          setDetail(json.memory as MemoryDetail);
        }
        if (lRes.ok) {
          const json = await lRes.json();
          setConnections((json.links ?? []) as Connection[]);
        }
      } catch {
        /* swallow — header still shows fallback node data */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  const accent = TYPE_COLORS[node.type] ?? "#8A8A8A";
  const summary = detail?.summary || detail?.content || "";
  const tags = detail?.tags ?? node.tags;

  const frame: React.CSSProperties = isMobile
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: "62%",
        borderTop: "1px solid var(--border)",
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        transform: entered ? "translateY(0)" : "translateY(100%)",
      }
    : {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 340,
        borderLeft: "1px solid var(--border)",
        transform: entered ? "translateX(0)" : "translateX(100%)",
      };

  return (
    <aside
      aria-label="Detalhe da memória"
      style={{
        ...frame,
        zIndex: 20,
        backgroundColor: "var(--surface)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "16px 16px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            marginTop: 5,
            width: 10,
            height: 10,
            borderRadius: "50%",
            backgroundColor: accent,
            boxShadow: `0 0 8px ${accent}`,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: 15,
              fontWeight: 700,
              color: "var(--text-primary)",
              lineHeight: 1.3,
              margin: 0,
              wordBreak: "break-word",
            }}
          >
            {detail?.title ?? node.label}
          </h3>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            <span style={{ color: accent, fontWeight: 600 }}>
              {TYPE_LABELS[node.type]}
            </span>
            <span>·</span>
            <span>
              {node.degree} {node.degree === 1 ? "conexão" : "conexões"}
            </span>
            {node.pinned && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                · <Pin size={11} /> fixada
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          style={{
            display: "flex",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 2,
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {/* Importance bar */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-muted)",
              marginBottom: 5,
            }}
          >
            <span>Importância</span>
            <span>{Math.round((detail?.importance ?? node.importance) * 100)}%</span>
          </div>
          <div
            style={{
              height: 5,
              borderRadius: 3,
              backgroundColor: "rgba(255,255,255,0.06)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.round((detail?.importance ?? node.importance) * 100)}%`,
                height: "100%",
                backgroundColor: accent,
              }}
            />
          </div>
        </div>

        {/* Summary / content */}
        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            <Loader2 size={14} className="animate-spin" /> Carregando…
          </div>
        ) : (
          summary && (
            <p
              style={{
                fontSize: 13,
                lineHeight: 1.55,
                color: "var(--text-secondary)",
                margin: "0 0 16px",
                whiteSpace: "pre-wrap",
              }}
            >
              {summary.length > 600 ? `${summary.slice(0, 600)}…` : summary}
            </p>
          )
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 18,
            }}
          >
            {tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 11,
                  padding: "3px 9px",
                  borderRadius: 999,
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Connections */}
        {connections.length > 0 && (
          <div>
            <p
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                margin: "0 0 8px",
              }}
            >
              Conexões ({connections.length})
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {connections.map((c) => (
                <button
                  key={c.memory.id}
                  type="button"
                  onClick={() => onNavigate(c.memory.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "rgba(0,0,0,0.2)",
                    cursor: "pointer",
                    color: "var(--text-primary)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--surface-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.2)";
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: TYPE_COLORS[c.memory.type] ?? "#8A8A8A",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 12.5,
                        lineHeight: 1.3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.memory.title}
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                      {LINK_KIND_LABELS[c.link.kind] ?? c.link.kind}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && connections.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Sem conexões ainda. Elas surgem automaticamente conforme memórias
            relacionadas são criadas.
          </p>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
        <Link
          href="/memory"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
            textDecoration: "none",
          }}
        >
          Abrir na Memória <ArrowUpRight size={13} />
        </Link>
      </div>
    </aside>
  );
}
