"use client";

import { useMemo } from "react";
import { STATUS_COLORS, type Task } from "./types";

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/**
 * Hand-rolled SVG DAG for the subtasks of the currently selected family
 * (the selected task's root + its descendants). We don't pull in cytoscape
 * because we already have a small graph (typically ≤ ~20 nodes per task
 * tree) and following the AgentOrganigrama precedent keeps bundle size flat.
 *
 * Layout: simple longest-path level assignment (every node is placed at the
 * max depth among its dependencies + 1). Within a level we lay nodes out
 * left-to-right by creation order.
 */
export function DependencyGraph({ tasks, selectedTaskId, onSelectTask }: Props) {
  const layout = useMemo(() => computeLayout(tasks, selectedTaskId), [tasks, selectedTaskId]);

  if (!layout || layout.nodes.length === 0) {
    return (
      <div className="rounded-lg p-4 text-center text-xs text-zinc-500" style={{ border: "1px dashed var(--border)" }}>
        Selecione uma task com dependências ou filhos para ver o DAG.
      </div>
    );
  }

  const { nodes, edges, width, height } = layout;

  return (
    <div className="rounded-lg p-2 overflow-x-auto" style={{ backgroundColor: "rgba(0,0,0,0.20)", border: "1px solid var(--border)" }}>
      <svg width={width} height={height} role="img" aria-label="Dependency graph">
        <defs>
          <marker
            id="arrowhead-dag"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
          </marker>
        </defs>

        {edges.map((edge, i) => (
          <line
            key={i}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke="#52525b"
            strokeWidth={1.2}
            markerEnd="url(#arrowhead-dag)"
            opacity={0.7}
          />
        ))}

        {nodes.map((node) => {
          const color = STATUS_COLORS[node.task.status as keyof typeof STATUS_COLORS] || "#71717a";
          const isSelected = node.task.id === selectedTaskId;
          return (
            <g
              key={node.task.id}
              transform={`translate(${node.x}, ${node.y})`}
              style={{ cursor: "pointer" }}
              onClick={() => onSelectTask(node.task.id)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={isSelected ? `${color}33` : "rgba(0,0,0,0.6)"}
                stroke={isSelected ? color : `${color}88`}
                strokeWidth={isSelected ? 2 : 1}
              />
              <circle cx={10} cy={10} r={4} fill={color} />
              <text x={20} y={14} fontSize={10} fill="#e4e4e7" fontWeight="bold">
                {(node.task.title || node.task.prompt).slice(0, 24)}
              </text>
              <text x={10} y={NODE_H - 8} fontSize={9} fill="#94a3b8">
                {node.task.assigned_to ?? "—"} · {node.task.status}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const NODE_W = 180;
const NODE_H = 44;
const COL_GAP = 60;
const ROW_GAP = 18;
const PAD = 16;

interface LayoutNode {
  task: Task;
  level: number;
  row: number;
  x: number;
  y: number;
}
interface LayoutEdge { x1: number; y1: number; x2: number; y2: number }
interface Layout { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number }

function computeLayout(allTasks: Task[], selectedTaskId: string | null): Layout | null {
  // Family resolution: walk up to find the root of the selected task, then
  // include all descendants. If nothing's selected, show the most recent
  // tree.
  const byId = new Map<string, Task>(allTasks.map((t) => [t.id, t]));
  let rootId: string | null = null;
  if (selectedTaskId && byId.has(selectedTaskId)) {
    let cursor: Task | null = byId.get(selectedTaskId)!;
    while (cursor?.parent_task_id && byId.has(cursor.parent_task_id)) {
      cursor = byId.get(cursor.parent_task_id) ?? null;
    }
    rootId = cursor?.id ?? null;
  }
  if (!rootId) {
    // Fallback: most recent task with at least one child or with deps
    const candidates = allTasks
      .filter((t) => t.depends_on.length > 0 || allTasks.some((u) => u.parent_task_id === t.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    rootId = candidates[0]?.id ?? null;
  }
  if (!rootId) return null;

  // BFS for descendants (parent_task_id pointing here OR depends_on
  // pointing here recursively).
  const family = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (family.has(id)) continue;
    family.add(id);
    for (const t of allTasks) {
      if (t.parent_task_id === id) queue.push(t.id);
      if (t.depends_on.includes(id)) queue.push(t.id);
    }
  }
  const familyTasks = allTasks.filter((t) => family.has(t.id));
  if (familyTasks.length === 0) return null;

  // Compute level = longest path from any node in the family that has no
  // family-internal deps. We treat parent_task_id implicitly: subtasks come
  // after parent.
  const level = new Map<string, number>();
  const inFamily = new Set(family);

  function lvl(taskId: string, visited: Set<string> = new Set()): number {
    if (visited.has(taskId)) return 0; // cycle guard
    visited.add(taskId);
    if (level.has(taskId)) return level.get(taskId)!;
    const t = byId.get(taskId);
    if (!t) return 0;
    const deps = t.depends_on.filter((d) => inFamily.has(d));
    const parentLvl =
      t.parent_task_id && inFamily.has(t.parent_task_id)
        ? lvl(t.parent_task_id, visited) + 1
        : 0;
    const depLvl = deps.length === 0 ? 0 : Math.max(...deps.map((d) => lvl(d, visited))) + 1;
    const v = Math.max(parentLvl, depLvl);
    level.set(taskId, v);
    return v;
  }
  for (const t of familyTasks) lvl(t.id);

  // Group by level and order within level by created_at
  const groups = new Map<number, Task[]>();
  for (const t of familyTasks) {
    const l = level.get(t.id) ?? 0;
    const arr = groups.get(l) ?? [];
    arr.push(t);
    groups.set(l, arr);
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const maxLevel = Math.max(...Array.from(groups.keys()));
  const maxRows = Math.max(...Array.from(groups.values()).map((a) => a.length));

  const nodes: LayoutNode[] = [];
  for (let l = 0; l <= maxLevel; l++) {
    const arr = groups.get(l) ?? [];
    for (let i = 0; i < arr.length; i++) {
      nodes.push({
        task: arr[i],
        level: l,
        row: i,
        x: PAD + l * (NODE_W + COL_GAP),
        y: PAD + i * (NODE_H + ROW_GAP),
      });
    }
  }

  const nodeById = new Map<string, LayoutNode>(nodes.map((n) => [n.task.id, n]));
  const edges: LayoutEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.task.depends_on) {
      const src = nodeById.get(dep);
      if (!src) continue;
      edges.push({
        x1: src.x + NODE_W,
        y1: src.y + NODE_H / 2,
        x2: n.x,
        y2: n.y + NODE_H / 2,
      });
    }
    if (n.task.parent_task_id && nodeById.has(n.task.parent_task_id) && n.task.depends_on.length === 0) {
      const parent = nodeById.get(n.task.parent_task_id)!;
      edges.push({
        x1: parent.x + NODE_W,
        y1: parent.y + NODE_H / 2,
        x2: n.x,
        y2: n.y + NODE_H / 2,
      });
    }
  }

  const width = PAD + (maxLevel + 1) * (NODE_W + COL_GAP);
  const height = PAD + maxRows * (NODE_H + ROW_GAP);
  return { nodes, edges, width, height };
}
