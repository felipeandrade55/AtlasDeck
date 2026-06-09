"use client";

/**
 * Reusable shell for the memory graph. Mounted both inside the "Grafo" tab of
 * /memory and on the standalone fullscreen /graph route (modo TV). Owns the
 * data fetch and all interactive state; the canvas itself is loaded client-only
 * via next/dynamic (it touches window/canvas).
 *
 * - `workspace`  filters the graph to one workspace (the tab passes the selected one).
 * - `fullscreen` switches the right-hand controls: the tab shows a built-in
 *   "Tela cheia" button (opens /graph); the /graph page injects its own
 *   `rightActions` (native fullscreen toggle + back).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Loader2, Maximize2, Network } from "lucide-react";
import type { MemoryType } from "@/lib/memory-db";
import { MEMORY_TYPES, GRAPH_BG } from "@/lib/graph-theme";
import { GraphControls } from "./GraphControls";
import { NodeDetailPanel } from "./NodeDetailPanel";
import type { GraphNode, GraphLink } from "./MemoryGraphCanvas";
import { useIsMobile } from "@/hooks/useMediaQuery";

const MemoryGraphCanvas = dynamic(() => import("./MemoryGraphCanvas"), {
  ssr: false,
  loading: () => <CenterMessage spinner text="Montando o grafo…" />,
});

interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface Props {
  workspace?: string;
  fullscreen?: boolean;
  rightActions?: React.ReactNode;
  /** Fade out the floating controls (ambient/TV auto-hide). */
  controlsHidden?: boolean;
}

export function MemoryGraphView({
  workspace,
  fullscreen = false,
  rightActions,
  controlsHidden = false,
}: Props) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<Set<MemoryType>>(
    () => new Set(MEMORY_TYPES),
  );
  const [showLabels, setShowLabels] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const nonceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Reset the view for the new workspace / rebuild — synchronous resets are intentional.
    setLoading(true);
    setError(null);
    setSelected(null);
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    fetch(`/api/memory/graph${qs}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as GraphPayload;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, reloadNonce]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      const res = await fetch("/api/memory/links/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspace ? { workspace } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Pull the freshly rebuilt edges back into the view.
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  }, [workspace]);

  const toggleType = useCallback((t: MemoryType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const focusNode = useCallback(
    (id: string) => {
      const node = data?.nodes.find((n) => n.id === id) ?? null;
      if (node) setSelected(node);
      nonceRef.current += 1;
      setFocusRequest({ id, nonce: nonceRef.current });
    },
    [data],
  );

  const hasNodes = !!data && data.nodes.length > 0;

  const builtInRight = !fullscreen ? (
    <Link
      href="/graph"
      title="Abrir em tela cheia (modo TV)"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 34,
        padding: "0 13px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        backgroundColor: "rgba(26,26,26,0.85)",
        backdropFilter: "blur(8px)",
        color: "var(--text-secondary)",
        fontSize: 12,
        fontWeight: 600,
        textDecoration: "none",
      }}
    >
      <Maximize2 size={14} />
      Tela cheia
    </Link>
  ) : (
    rightActions
  );

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 0,
        backgroundColor: GRAPH_BG,
        overflow: "hidden",
      }}
    >
      {hasNodes && (
        <>
          <div style={{ position: "absolute", inset: 0 }}>
            <MemoryGraphCanvas
              nodes={data!.nodes}
              links={data!.links}
              search={search}
              typeFilter={typeFilter}
              showLabels={showLabels}
              selectedId={selected?.id ?? null}
              onSelectNode={setSelected}
              focusRequest={focusRequest}
              fitNonce={fitNonce}
            />
          </div>

          <GraphControls
            search={search}
            onSearch={setSearch}
            typeFilter={typeFilter}
            onToggleType={toggleType}
            showLabels={showLabels}
            onToggleLabels={() => setShowLabels((v) => !v)}
            onRecenter={() => setFitNonce((n) => n + 1)}
            onRebuild={rebuild}
            rebuilding={rebuilding}
            nodeCount={data!.nodes.length}
            rightActions={builtInRight}
            hidden={controlsHidden}
          />

          {selected && (
            <NodeDetailPanel
              node={selected}
              isMobile={isMobile}
              onClose={() => setSelected(null)}
              onNavigate={focusNode}
            />
          )}
        </>
      )}

      {loading && <CenterMessage spinner text="Carregando memórias…" />}

      {!loading && error && (
        <CenterMessage text={`Não foi possível carregar o grafo (${error}).`} />
      )}

      {!loading && !error && !hasNodes && (
        <CenterMessage
          icon
          text="Ainda não há memórias conectadas. As conexões aparecem automaticamente conforme novas memórias são criadas."
        />
      )}
    </div>
  );
}

function CenterMessage({
  text,
  spinner,
  icon,
}: {
  text: string;
  spinner?: boolean;
  icon?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        textAlign: "center",
        color: "var(--text-muted)",
        backgroundColor: GRAPH_BG,
        pointerEvents: "none",
      }}
    >
      {spinner && <Loader2 size={22} className="animate-spin" />}
      {icon && <Network size={40} style={{ opacity: 0.35 }} />}
      <p style={{ fontSize: 13, maxWidth: 360, lineHeight: 1.5, margin: 0 }}>
        {text}
      </p>
    </div>
  );
}
