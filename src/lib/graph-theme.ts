/**
 * Shared visual constants for the Obsidian-style memory graph.
 *
 * Pure data — no JSX, no DOM. Imported by both the canvas renderer
 * (MemoryGraphCanvas) and the React chrome (NodeDetailPanel / GraphControls)
 * so colors and labels stay in sync. Canvas can't resolve CSS `var(...)`,
 * so colors are hard literals mirroring the theme tokens in globals.css.
 */
import type { MemoryType, LinkKind } from "@/lib/memory-db";

export const GRAPH_BG = "#0C0C0C"; // --bg
export const ACCENT = "#FF3B30"; // --accent (coral) — reserved for hover/selection
export const ACCENT_HOT = "#FF6A60"; // brighter coral for the hot node fill

/** Node color by memory type (mirrors theme tokens). */
export const TYPE_COLORS: Record<MemoryType, string> = {
  episodic: "#0A84FF", // --info (blue) — "what happened"
  semantic: "#32D74B", // --positive (green) — "facts / knowledge"
  procedural: "#BF5AF2", // --type-command (purple) — "how to"
  identity: "#FF3B30", // --accent (coral) — "who / about the owner"
};

/** Human labels (pt-BR) for the type-filter chips. */
export const TYPE_LABELS: Record<MemoryType, string> = {
  episodic: "Episódica",
  semantic: "Semântica",
  procedural: "Procedural",
  identity: "Identidade",
};

export const MEMORY_TYPES: MemoryType[] = [
  "episodic",
  "semantic",
  "procedural",
  "identity",
];

/** Friendly labels for link kinds (used in the detail panel). */
export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  related: "relacionada",
  contradicts: "contradiz",
  supersedes: "substitui",
  caused_by: "causada por",
  duplicate_of: "duplicata de",
  derived_from: "derivada de",
  superseded_by: "substituída por",
};

/** Zoom level above which every node's label is drawn. */
export const LABEL_ZOOM = 1.6;

/**
 * Node radius from connection count + importance. Square-root keeps very
 * connected hubs from dwarfing everything; importance adds a small bump.
 */
export function nodeRadius(degree: number, importance: number): number {
  return 2.2 + Math.sqrt(degree) * 1.5 + importance * 2.2;
}

/** Edge opacity scales with link weight (kept subtle, Obsidian-like). */
export function linkAlpha(weight: number): number {
  return 0.06 + weight * 0.16;
}
