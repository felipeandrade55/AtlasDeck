"use client";

import { useCallback, useMemo, useState } from "react";
import { DollarSign, ArrowDown, GitBranch, Clock } from "lucide-react";
import { STATUS_COLUMNS, STATUS_COLORS, STATUS_LABELS, type Task, type TaskStatus } from "./types";

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onStatusChange: (taskId: string, nextStatus: TaskStatus) => Promise<void>;
}

/**
 * 7-column kanban with HTML5 drag-and-drop. Cards show: title, assignee,
 * cost, elapsed time, depends-on indicator. Drag a card to a new column to
 * PATCH its status — server validates the transition.
 *
 * We intentionally don't restrict transitions client-side: power users may
 * want to bump a stuck task back from "review" to "in_progress" or skip
 * "testing". Forward flow is just the default visual reading order.
 */
export function KanbanBoard({ tasks, selectedTaskId, onSelectTask, onStatusChange }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoveredCol, setHoveredCol] = useState<TaskStatus | null>(null);

  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_COLUMNS) map.set(s, []);
    for (const t of tasks) {
      const bucket = map.get(t.status as TaskStatus);
      if (bucket) bucket.push(t);
    }
    return map;
  }, [tasks]);

  const handleDrop = useCallback(
    async (e: React.DragEvent, status: TaskStatus) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      setDraggingId(null);
      setHoveredCol(null);
      if (!id) return;
      const task = tasks.find((t) => t.id === id);
      if (!task || task.status === status) return;
      await onStatusChange(id, status);
    },
    [tasks, onStatusChange],
  );

  return (
    <div className="flex gap-2 overflow-x-auto pb-2" style={{ minHeight: 320 }}>
      {STATUS_COLUMNS.map((status) => {
        const items = byStatus.get(status) ?? [];
        const isHovered = hoveredCol === status;
        const color = STATUS_COLORS[status];
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setHoveredCol(status);
            }}
            onDragLeave={() => setHoveredCol((c) => (c === status ? null : c))}
            onDrop={(e) => handleDrop(e, status)}
            className="flex-1 min-w-[160px] rounded-lg flex flex-col"
            style={{
              backgroundColor: isHovered ? `${color}15` : "rgba(255,255,255,0.02)",
              border: `1px dashed ${isHovered ? color : "var(--border)"}`,
            }}
          >
            <div
              className="px-2 py-1.5 flex items-center justify-between border-b"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">
                  {STATUS_LABELS[status]}
                </span>
              </div>
              <span className="text-[10px] font-bold text-zinc-500">{items.length}</span>
            </div>
            <div className="flex-1 px-1.5 py-1.5 overflow-y-auto space-y-1.5">
              {items.length === 0 && (
                <div className="text-center py-4 text-[10px] text-zinc-600">—</div>
              )}
              {items.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  dragging={draggingId === task.id}
                  onSelect={() => onSelectTask(task.id)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingId(task.id);
                  }}
                  onDragEnd={() => setDraggingId(null)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

function TaskCard({ task, selected, dragging, onSelect, onDragStart, onDragEnd }: TaskCardProps) {
  const color = STATUS_COLORS[task.status as TaskStatus];
  const elapsed = task.started_at
    ? formatElapsed(Date.now() - new Date(task.started_at).getTime())
    : task.created_at
    ? formatElapsed(Date.now() - new Date(task.created_at).getTime())
    : "?";

  return (
    <div
      draggable
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="px-2 py-1.5 rounded-md cursor-pointer transition-all hover:translate-y-[-1px]"
      style={{
        backgroundColor: selected ? "rgba(59,130,246,0.18)" : "rgba(0,0,0,0.4)",
        border: `1px solid ${selected ? "rgba(59,130,246,0.6)" : `${color}55`}`,
        opacity: dragging ? 0.4 : 1,
      }}
    >
      <div
        className="text-[11px] font-semibold text-white leading-tight line-clamp-2"
        title={task.title || task.prompt}
      >
        {task.title || task.prompt.slice(0, 50)}
      </div>
      <div className="flex items-center justify-between mt-1 gap-1">
        <span
          className="text-[9px] text-zinc-400 truncate"
          title={task.delegated_by ? `${task.delegated_by} → ${task.assigned_to ?? "?"}` : task.assigned_to || undefined}
        >
          {task.delegated_by
            ? `${task.delegated_by} → ${task.assigned_to ?? "?"}`
            : task.assigned_to
            ? `→ ${task.assigned_to}`
            : "—"}
        </span>
        {task.depends_on.length > 0 && (
          <span title={`depende de ${task.depends_on.length}`} className="text-[9px] text-amber-300 flex items-center gap-0.5">
            <GitBranch className="w-2.5 h-2.5" />
            {task.depends_on.length}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between mt-1 text-[9px] text-zinc-500">
        <span className="flex items-center gap-0.5" title="custo até agora">
          <DollarSign className="w-2.5 h-2.5" />
          {task.cost_cents}¢
        </span>
        <span className="flex items-center gap-0.5" title="tempo desde início/criação">
          <Clock className="w-2.5 h-2.5" />
          {elapsed}
        </span>
        {task.user_approved === true && (
          <span title="usuário aprovou">👍</span>
        )}
        {task.user_approved === false && (
          <span title="usuário rejeitou">👎</span>
        )}
        {task.parent_task_id && (
          <span title="subtask" className="flex items-center">
            <ArrowDown className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "agora";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
