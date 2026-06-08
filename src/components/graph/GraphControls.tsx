"use client";

/**
 * Floating control bar for the memory graph: search, per-type filter chips,
 * a label toggle and a recenter button. Mode-specific buttons (open
 * fullscreen / native fullscreen / back) are injected via `rightActions`.
 */
import { Search, Tag, Crosshair, X } from "lucide-react";
import type { MemoryType } from "@/lib/memory-db";
import { MEMORY_TYPES, TYPE_COLORS, TYPE_LABELS } from "@/lib/graph-theme";

interface Props {
  search: string;
  onSearch: (value: string) => void;
  typeFilter: Set<MemoryType>;
  onToggleType: (type: MemoryType) => void;
  showLabels: boolean;
  onToggleLabels: () => void;
  onRecenter: () => void;
  nodeCount: number;
  rightActions?: React.ReactNode;
  /** Fade out + disable (ambient/TV auto-hide). */
  hidden?: boolean;
}

export function GraphControls({
  search,
  onSearch,
  typeFilter,
  onToggleType,
  showLabels,
  onToggleLabels,
  onRecenter,
  nodeCount,
  rightActions,
  hidden = false,
}: Props) {
  const pe = hidden ? "none" : "auto";
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        zIndex: 10,
        pointerEvents: "none",
        opacity: hidden ? 0 : 1,
        transition: "opacity 0.35s ease",
      }}
    >
      {/* Search */}
      <div
        style={{
          position: "relative",
          pointerEvents: pe,
          display: "flex",
          alignItems: "center",
        }}
      >
        <Search
          size={14}
          style={{
            position: "absolute",
            left: 10,
            color: "var(--text-muted)",
            pointerEvents: "none",
          }}
        />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Buscar memória…"
          style={{
            width: 200,
            height: 34,
            padding: "0 28px 0 30px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            backgroundColor: "rgba(26,26,26,0.85)",
            backdropFilter: "blur(8px)",
            color: "var(--text-primary)",
            fontSize: 13,
            outline: "none",
          }}
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch("")}
            aria-label="Limpar busca"
            style={{
              position: "absolute",
              right: 8,
              display: "flex",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Type filter chips */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 6px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          backgroundColor: "rgba(26,26,26,0.85)",
          backdropFilter: "blur(8px)",
          pointerEvents: pe,
        }}
      >
        {MEMORY_TYPES.map((type) => {
          const active = typeFilter.has(type);
          return (
            <button
              key={type}
              type="button"
              onClick={() => onToggleType(type)}
              aria-pressed={active}
              title={TYPE_LABELS[type]}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 9px",
                borderRadius: 6,
                border: "none",
                background: active ? "rgba(255,255,255,0.06)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-muted)",
                fontSize: 12,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                opacity: active ? 1 : 0.55,
                transition: "opacity 120ms ease, background 120ms ease",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: TYPE_COLORS[type],
                  boxShadow: active ? `0 0 6px ${TYPE_COLORS[type]}` : "none",
                }}
              />
              {TYPE_LABELS[type]}
            </button>
          );
        })}
      </div>

      {/* Labels toggle */}
      <button
        type="button"
        onClick={onToggleLabels}
        aria-pressed={showLabels}
        title="Mostrar/ocultar rótulos"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 34,
          padding: "0 12px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          backgroundColor: showLabels
            ? "var(--accent-soft)"
            : "rgba(26,26,26,0.85)",
          backdropFilter: "blur(8px)",
          color: showLabels ? "var(--accent)" : "var(--text-secondary)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          pointerEvents: pe,
        }}
      >
        <Tag size={14} />
        Rótulos
      </button>

      {/* Recenter */}
      <button
        type="button"
        onClick={onRecenter}
        title="Recentralizar"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          borderRadius: 8,
          border: "1px solid var(--border)",
          backgroundColor: "rgba(26,26,26,0.85)",
          backdropFilter: "blur(8px)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          pointerEvents: pe,
        }}
      >
        <Crosshair size={15} />
      </button>

      {/* Node count */}
      <span
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          padding: "0 4px",
          pointerEvents: "none",
        }}
      >
        {nodeCount} {nodeCount === 1 ? "memória" : "memórias"}
      </span>

      <div style={{ flex: 1 }} />

      {rightActions && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            pointerEvents: pe,
          }}
        >
          {rightActions}
        </div>
      )}
    </div>
  );
}
