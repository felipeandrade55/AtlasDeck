"use client";

/**
 * Obsidian-style force-directed canvas for the memory graph.
 *
 * Client-only (uses `window`/canvas) — must be loaded via
 * `dynamic(() => import(...), { ssr: false })`. Wraps the vanilla
 * `force-graph` engine (no React dependency, immune to React 19 peer churn)
 * and drives all the aesthetics through `nodeCanvasObject`/`linkColor`.
 *
 * Interactive state (hover, search, filters, selection) lives in refs so the
 * per-frame render functions always read fresh values without re-creating the
 * graph (which would reset zoom and node positions). `autoPauseRedraw(false)`
 * keeps the canvas repainting every frame so those ref-driven visuals stay
 * live — fine at this scale, and it gives the ambient "breathing" feel on a TV.
 */
import { useEffect, useRef } from "react";
import ForceGraph from "force-graph";
import type { MemoryType, LinkKind } from "@/lib/memory-db";
import {
  TYPE_COLORS,
  ACCENT,
  ACCENT_HOT,
  GRAPH_BG,
  LABEL_ZOOM,
  nodeRadius,
  linkAlpha,
} from "@/lib/graph-theme";

export interface GraphNode {
  id: string;
  label: string;
  type: MemoryType;
  importance: number;
  degree: number;
  tags: string[];
  pinned: boolean;
  // Added at runtime by the force engine:
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  kind: LinkKind;
  weight: number;
}

interface Props {
  nodes: GraphNode[];
  links: GraphLink[];
  search: string;
  typeFilter: Set<MemoryType>;
  showLabels: boolean;
  selectedId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  onHoverNode?: (node: GraphNode | null) => void;
  /** Set by parent to pan/zoom to a node (e.g. clicking a connection). */
  focusRequest: { id: string; nonce: number } | null;
  /** Increment to trigger zoom-to-fit (recenter button). */
  fitNonce: number;
}

const endId = (e: string | GraphNode): string =>
  typeof e === "object" && e !== null ? e.id : (e as string);

export default function MemoryGraphCanvas(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph<GraphNode, GraphLink> | null>(null);

  // --- Mutable mirrors of interactive state, read inside per-frame draws ---
  const hoverRef = useRef<string | null>(null);
  const neighborsRef = useRef<Set<string>>(new Set());
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  const nodeByIdRef = useRef<Map<string, GraphNode>>(new Map());
  const nodeCountRef = useRef(0);
  const searchRef = useRef("");
  const typeFilterRef = useRef<Set<MemoryType>>(props.typeFilter);
  const showLabelsRef = useRef(props.showLabels);
  const selectedRef = useRef<string | null>(props.selectedId);

  // Callback mirrors so the engine's once-bound handlers never go stale.
  const onSelectRef = useRef(props.onSelectNode);
  const onHoverRef = useRef(props.onHoverNode);

  // Mirror the latest interactive state into refs after each render. The
  // per-frame canvas draws run on the engine's rAF loop (not React's), so they
  // read these refs to stay fresh without re-creating the graph (which would
  // reset zoom/positions).
  useEffect(() => {
    searchRef.current = props.search.trim().toLowerCase();
    typeFilterRef.current = props.typeFilter;
    showLabelsRef.current = props.showLabels;
    selectedRef.current = props.selectedId;
    onSelectRef.current = props.onSelectNode;
    onHoverRef.current = props.onHoverNode;
  });

  // --- Create the graph once on mount ---
  useEffect(() => {
    if (!containerRef.current) return;
    const graph = new ForceGraph<GraphNode, GraphLink>(containerRef.current);
    graphRef.current = graph;

    graph
      .backgroundColor(GRAPH_BG)
      .nodeId("id")
      .nodeRelSize(1)
      .autoPauseRedraw(false)
      .cooldownTicks(140)
      .d3VelocityDecay(0.32)
      .nodeVisibility((n) => typeFilterRef.current.has(n.type))
      .linkVisibility((l) => {
        const s = nodeByIdRef.current.get(endId(l.source));
        const t = nodeByIdRef.current.get(endId(l.target));
        return !!s && !!t &&
          typeFilterRef.current.has(s.type) &&
          typeFilterRef.current.has(t.type);
      })
      .linkColor((l) => {
        const hover = hoverRef.current;
        const hot =
          hover && (endId(l.source) === hover || endId(l.target) === hover);
        if (hot) return "rgba(255,59,48,0.55)";
        const a = linkAlpha(l.weight);
        return hover
          ? `rgba(138,138,138,${(a * 0.25).toFixed(3)})`
          : `rgba(138,138,138,${a.toFixed(3)})`;
      })
      .linkWidth((l) => {
        const hover = hoverRef.current;
        const hot =
          hover && (endId(l.source) === hover || endId(l.target) === hover);
        return (hot ? 1.2 : 0.5) + l.weight * 0.8;
      })
      .nodeCanvasObjectMode(() => "replace")
      .nodeCanvasObject((node, ctx, globalScale) => {
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const r = nodeRadius(node.degree, node.importance);
        const color = TYPE_COLORS[node.type] ?? "#8A8A8A";
        const hover = hoverRef.current;
        const search = searchRef.current;
        const isSelected = node.id === selectedRef.current;
        const isHot =
          node.id === hover || neighborsRef.current.has(node.id);
        const matches = search ? node.label.toLowerCase().includes(search) : true;

        // Dim non-neighbors on hover, or non-matches while searching.
        let dim = false;
        if (hover) dim = node.id !== hover && !isHot;
        else if (search) dim = !matches;

        // Skip the (expensive) shadow glow on very large graphs to stay smooth.
        const allowGlow = nodeCountRef.current <= 350;

        ctx.save();
        ctx.globalAlpha = dim ? 0.12 : 1;

        if (allowGlow) {
          ctx.shadowBlur = isHot || (!!search && matches) ? 20 : 9;
          ctx.shadowColor = isHot ? ACCENT : color;
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = isHot ? ACCENT_HOT : color;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Subtle white ring for pinned memories.
        if (node.pinned && !isSelected) {
          ctx.lineWidth = 1 / globalScale;
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.beginPath();
          ctx.arc(x, y, r + 1.5 / globalScale, 0, 2 * Math.PI);
          ctx.stroke();
        }
        // Coral selection ring.
        if (isSelected) {
          ctx.lineWidth = 1.5 / globalScale;
          ctx.strokeStyle = ACCENT;
          ctx.beginPath();
          ctx.arc(x, y, r + 3 / globalScale, 0, 2 * Math.PI);
          ctx.stroke();
        }

        // Labels: when zoomed in, toggled on, hovered, selected, pinned, or a search hit.
        const showLabel =
          showLabelsRef.current ||
          globalScale > LABEL_ZOOM ||
          node.id === hover ||
          isSelected ||
          node.pinned ||
          (!!search && matches);
        if (showLabel) {
          const fontSize = Math.max(10 / globalScale, 1.6);
          ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = dim
            ? "rgba(120,120,120,0.5)"
            : "rgba(222,222,222,0.92)";
          const label =
            node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label;
          ctx.fillText(label, x, y + r + 1.5 / globalScale);
        }
        ctx.restore();
      })
      // Match the clickable/hover area to the drawn circle.
      .nodePointerAreaPaint((node, color, ctx) => {
        const r = nodeRadius(node.degree, node.importance);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, r + 2, 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeHover((node) => {
        hoverRef.current = node ? node.id : null;
        neighborsRef.current = node
          ? adjacencyRef.current.get(node.id) ?? new Set()
          : new Set();
        onHoverRef.current?.(node ?? null);
      })
      .onNodeClick((node) => {
        onSelectRef.current(node);
        if (node.x != null && node.y != null) {
          graph.centerAt(node.x, node.y, 600);
          graph.zoom(Math.max(graph.zoom(), 2.2), 600);
        }
      })
      .onBackgroundClick(() => {
        onSelectRef.current(null);
      });

    // Spread the layout out a bit and let stronger links pull closer.
    const charge = graph.d3Force("charge");
    if (charge) (charge as unknown as { strength: (s: number) => void }).strength(-95);
    const linkForce = graph.d3Force("link");
    if (linkForce) {
      (linkForce as unknown as {
        distance: (fn: (l: GraphLink) => number) => void;
      }).distance((l) => 28 + (1 - l.weight) * 60);
    }

    // One-time fit once the simulation settles.
    let didFit = false;
    graph.onEngineStop(() => {
      if (!didFit) {
        didFit = true;
        graph.zoomToFit(600, 48);
      }
    });

    return () => {
      try {
        graph._destructor();
      } catch {
        /* noop */
      }
      graphRef.current = null;
    };
  }, []);

  // --- Feed data (and rebuild adjacency) when nodes/links change ---
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const byId = new Map<string, GraphNode>();
    for (const n of props.nodes) byId.set(n.id, n);
    nodeByIdRef.current = byId;
    nodeCountRef.current = props.nodes.length;

    const adj = new Map<string, Set<string>>();
    for (const l of props.links) {
      const s = endId(l.source);
      const t = endId(l.target);
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    adjacencyRef.current = adj;

    // Clone links — force-graph mutates source/target into node refs.
    graph.graphData({
      nodes: props.nodes,
      links: props.links.map((l) => ({ ...l })),
    });
  }, [props.nodes, props.links]);

  // --- Re-assert visibility accessors when the type filter changes ---
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph
      .nodeVisibility((n) => typeFilterRef.current.has(n.type))
      .linkVisibility((l) => {
        const s = nodeByIdRef.current.get(endId(l.source));
        const t = nodeByIdRef.current.get(endId(l.target));
        return !!s && !!t &&
          typeFilterRef.current.has(s.type) &&
          typeFilterRef.current.has(t.type);
      });
  }, [props.typeFilter]);

  // --- Resize to fill the container ---
  useEffect(() => {
    const el = containerRef.current;
    const graph = graphRef.current;
    if (!el || !graph) return;
    const apply = () => graph.width(el.clientWidth).height(el.clientHeight);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Focus a specific node on request ---
  useEffect(() => {
    const graph = graphRef.current;
    const req = props.focusRequest;
    if (!graph || !req) return;
    const node = nodeByIdRef.current.get(req.id);
    if (node && node.x != null && node.y != null) {
      graph.centerAt(node.x, node.y, 600);
      graph.zoom(Math.max(graph.zoom(), 2.4), 600);
    }
  }, [props.focusRequest]);

  // --- Zoom to fit on request (recenter button) ---
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.zoomToFit(500, 48);
  }, [props.fitNonce]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
