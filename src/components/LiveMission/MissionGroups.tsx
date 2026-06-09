"use client";

import { useMemo } from "react";
import { Layers, ArrowDown } from "lucide-react";
import { STATUS_COLORS, STATUS_LABELS, type Task, type TaskStatus } from "./types";

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

interface Group {
  root: Task;
  members: Task[]; // all tasks in the family except the root
}

/**
 * "Por missão" view — groups tasks by their root mission instead of by
 * status. A mission = a root task (no parent) together with everything
 * descended from it (decompose subtasks). Tasks that stand alone (a single
 * delegate_to or a plain chat task with no children) are collected under
 * "Avulsas". Complements the status kanban: here you read a whole mission
 * top-to-bottom instead of hunting its pieces across 7 columns.
 */
export function MissionGroups({ tasks, selectedTaskId, onSelectTask }: Props) {
  const { groups, loose } = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const t of tasks) byId.set(t.id, t);

    const rootOf = (t: Task): Task => {
      let cur = t;
      const seen = new Set<string>();
      while (cur.parent_task_id && byId.has(cur.parent_task_id) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parent_task_id)!;
      }
      return cur;
    };

    const byRoot = new Map<string, Task[]>();
    for (const t of tasks) {
      const root = rootOf(t);
      if (!byRoot.has(root.id)) byRoot.set(root.id, []);
      byRoot.get(root.id)!.push(t);
    }

    const groups: Group[] = [];
    const loose: Task[] = [];
    for (const [rootId, members] of byRoot.entries()) {
      const root = byId.get(rootId)!;
      const children = members.filter((m) => m.id !== rootId);
      // A real "mission" has at least one subtask. Singletons are loose.
      if (children.length > 0) {
        groups.push({ root, members: children });
      } else {
        loose.push(root);
      }
    }
    // Newest missions first (by root creation).
    groups.sort((a, b) => (a.root.created_at < b.root.created_at ? 1 : -1));
    loose.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { groups, loose };
  }, [tasks]);

  if (groups.length === 0 && loose.length === 0) {
    return (
      <div
        className="rounded-xl p-6 text-center text-xs text-zinc-500"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        Nenhuma task ainda.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map(({ root, members }) => {
        const doneCount = members.filter((m) => m.status === "done").length;
        return (
          <div
            key={root.id}
            className="rounded-xl overflow-hidden"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
          >
            {/* Mission header (root task) */}
            <button
              type="button"
              onClick={() => onSelectTask(root.id)}
              className="w-full text-left px-3 py-2 flex items-center gap-2 border-b transition-colors hover:bg-zinc-800/40"
              style={{
                borderColor: "var(--border)",
                background:
                  selectedTaskId === root.id ? "rgba(59,130,246,0.12)" : "transparent",
                cursor: "pointer",
              }}
            >
              <Layers className="w-4 h-4 text-purple-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-white truncate">
                  {root.title || root.prompt.slice(0, 60)}
                </div>
                <div className="text-[10px] text-zinc-500">
                  {root.delegated_by ? `${root.delegated_by} · ` : ""}
                  {members.length} subtarefa(s) · {doneCount} concluída(s)
                </div>
              </div>
              <StatusBadge status={root.status as TaskStatus} />
            </button>

            {/* Subtasks */}
            <div className="p-1.5 space-y-1">
              {members.map((m) => (
                <SubtaskRow
                  key={m.id}
                  task={m}
                  selected={m.id === selectedTaskId}
                  onSelect={() => onSelectTask(m.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {loose.length > 0 && (
        <div
          className="rounded-xl overflow-hidden"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div
            className="px-3 py-2 border-b text-[10px] font-bold uppercase tracking-wider text-zinc-400"
            style={{ borderColor: "var(--border)" }}
          >
            Avulsas ({loose.length})
          </div>
          <div className="p-1.5 space-y-1">
            {loose.map((m) => (
              <SubtaskRow
                key={m.id}
                task={m}
                selected={m.id === selectedTaskId}
                onSelect={() => onSelectTask(m.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SubtaskRow({
  task,
  selected,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 transition-colors hover:bg-zinc-800/50"
      style={{
        background: selected ? "rgba(59,130,246,0.15)" : "transparent",
        border: `1px solid ${selected ? "rgba(59,130,246,0.5)" : "transparent"}`,
        cursor: "pointer",
      }}
    >
      {task.parent_task_id && <ArrowDown className="w-3 h-3 text-zinc-600 shrink-0" />}
      <span className="text-[11px] text-white truncate flex-1">
        {task.title || task.prompt.slice(0, 50)}
      </span>
      {task.assigned_to && (
        <span className="text-[9px] text-zinc-400 shrink-0">→ {task.assigned_to}</span>
      )}
      <StatusBadge status={task.status as TaskStatus} small />
    </button>
  );
}

function StatusBadge({ status, small }: { status: TaskStatus; small?: boolean }) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className={`shrink-0 rounded font-bold uppercase tracking-wider ${
        small ? "text-[8px] px-1 py-0.5" : "text-[9px] px-1.5 py-0.5"
      }`}
      style={{ backgroundColor: `${color}22`, color }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
