"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ThumbsUp,
  ThumbsDown,
  XCircle,
  RotateCcw,
  Send,
  Clock,
  DollarSign,
  Cpu,
} from "lucide-react";
import { DependencyGraph } from "./DependencyGraph";
import { STATUS_COLORS, STATUS_LABELS, type Task, type MailMessage, type Checkpoint } from "./types";

interface Props {
  task: Task;
  allTasks: Task[];
  onMutated: () => void;
  onSelectTask: (taskId: string) => void;
}

/**
 * Expanded view of the selected task: hero header, dependency graph of the
 * task family, action row, chat history, and the latest checkpoint payload.
 *
 * Actions:
 *   - Pause/Resume (Pause = move to cancelled; resume = re-delegate)
 *   - Kill = cancel
 *   - Re-delegate = clone task with same prompt + assignee in `inbox`
 *   - Send Note = quick mailbox post (queued by default)
 *   - 👍 / 👎 only enabled when status = review
 */
export function TaskDetailPanel({ task, allTasks, onMutated, onSelectTask }: Props) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteUrgent, setNoteUrgent] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  // Pull the full detail (children/checkpoints/messages) whenever the task
  // selection changes. The kanban already has the top-level task object so
  // we render the hero header from props before this resolves.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
    } catch {
      // swallow
    }
  }, [task.id]);

  useEffect(() => {
    setNoteDraft("");
    setFeedback("");
    refresh();
  }, [task.id, refresh]);

  // Also refresh when the upstream task object mutates (status change pushed
  // in by the SSE stream).
  useEffect(() => {
    refresh();
  }, [task.status, task.cost_cents, refresh]);

  const handleAction = useCallback(
    async (label: string, run: () => Promise<Response>) => {
      setBusy(true);
      try {
        const res = await run();
        if (!res.ok) {
          console.error(`[task-detail] ${label} failed:`, await res.text());
          return;
        }
        onMutated();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [onMutated, refresh],
  );

  const handleApprove = (approved: boolean) =>
    handleAction(`approve(${approved})`, () =>
      fetch(`/api/tasks/${task.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, feedback: feedback.trim() || undefined }),
      }),
    );

  const handleKill = () =>
    handleAction("kill", () =>
      fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      }),
    );

  const handleReDelegate = () =>
    handleAction("re-delegate", () =>
      fetch(`/api/tasks/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assigned_to: task.assigned_to,
          delegated_by: task.delegated_by,
          prompt: task.prompt,
          title: `${task.title} (retry)`,
          metadata: { retry_of: task.id },
        }),
      }),
    );

  const handleSendNote = () => {
    if (!noteDraft.trim()) return;
    handleAction("send-note", () =>
      fetch(`/api/mailbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_agent_id: task.assigned_to,
          task_id: task.id,
          body: noteDraft.trim(),
          message_type: noteUrgent ? "direct_message" : "queued_note",
          from_agent_id: null,
        }),
      }),
    );
    setNoteDraft("");
  };

  const color = STATUS_COLORS[task.status as keyof typeof STATUS_COLORS];
  const elapsedMs = task.completed_at
    ? new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()
    : Date.now() - new Date(task.created_at).getTime();
  const isReview = task.status === "review";
  const isTerminal = task.status === "done" || task.status === "cancelled" || task.status === "failed";

  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* Hero */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
              style={{ backgroundColor: `${color}33`, color }}
            >
              {STATUS_LABELS[task.status]}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">{task.id.slice(0, 8)}</span>
            {task.parent_task_id && (
              <button
                type="button"
                onClick={() => onSelectTask(task.parent_task_id!)}
                className="text-[10px] text-blue-400 underline cursor-pointer hover:opacity-80"
                style={{ background: "none", border: "none", padding: 0 }}
              >
                ↑ parent
              </button>
            )}
          </div>
          <h3 className="text-base font-bold text-white leading-tight">{task.title || task.prompt.slice(0, 80)}</h3>
          <p className="text-[11px] text-zinc-400 mt-1 line-clamp-3">{task.prompt}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-zinc-500 flex-shrink-0">
          <span className="flex items-center gap-1" title="custo acumulado">
            <DollarSign className="w-3 h-3" />
            {task.cost_cents}¢
          </span>
          <span className="flex items-center gap-1" title="tempo total">
            <Clock className="w-3 h-3" />
            {formatElapsed(elapsedMs)}
          </span>
          <span className="flex items-center gap-1" title="tokens in / out">
            <Cpu className="w-3 h-3" />
            {task.tokens_in}↓ {task.tokens_out}↑
          </span>
        </div>
      </div>

      {/* Dependency graph (only if task has parent/children/deps) */}
      {(task.parent_task_id || task.depends_on.length > 0 || allTasks.some((t) => t.parent_task_id === task.id)) && (
        <DependencyGraph tasks={allTasks} selectedTaskId={task.id} onSelectTask={onSelectTask} />
      )}

      {/* Result preview (when present) */}
      {task.result && (
        <div className="rounded-lg p-2.5 text-[11px] text-zinc-300 max-h-32 overflow-y-auto whitespace-pre-wrap" style={{ backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid var(--border)" }}>
          <div className="text-[10px] font-bold uppercase text-zinc-500 mb-1">Resultado</div>
          {task.result}
        </div>
      )}

      {/* Review notes */}
      {task.review_notes && (
        <div className="rounded-lg p-2.5 text-[11px] text-amber-100 whitespace-pre-wrap" style={{ backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)" }}>
          <div className="text-[10px] font-bold uppercase text-amber-300 mb-1">
            Review verdict: {task.review_verdict ?? "—"}
          </div>
          {task.review_notes}
        </div>
      )}

      {/* Approval row when in review */}
      {isReview && (
        <div className="space-y-2 rounded-lg p-3" style={{ backgroundColor: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.30)" }}>
          <div className="text-[11px] text-amber-300 font-semibold">
            Aguardando seu 👍 / 👎
          </div>
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Comentário (opcional, alimenta o preference model)"
            className="w-full px-2.5 py-1.5 rounded text-[11px] outline-none bg-zinc-900 border text-white"
            style={{ borderColor: "var(--border)" }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleApprove(true)}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs font-semibold transition-all hover:scale-105 disabled:opacity-50"
              style={{ backgroundColor: "#16a34a", color: "white", border: "none", cursor: "pointer" }}
            >
              <ThumbsUp className="w-3.5 h-3.5" /> Aprovar
            </button>
            <button
              type="button"
              onClick={() => handleApprove(false)}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs font-semibold transition-all hover:scale-105 disabled:opacity-50"
              style={{ backgroundColor: "#dc2626", color: "white", border: "none", cursor: "pointer" }}
            >
              <ThumbsDown className="w-3.5 h-3.5" /> Rejeitar
            </button>
          </div>
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-wrap gap-2">
        {!isTerminal && (
          <button
            type="button"
            onClick={handleKill}
            disabled={busy}
            className="px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-colors hover:bg-red-950"
            style={{ border: "1px solid rgba(239,68,68,0.4)", backgroundColor: "rgba(239,68,68,0.10)", color: "#fca5a5", cursor: "pointer" }}
          >
            <XCircle className="w-3 h-3" /> Cancelar task
          </button>
        )}
        {isTerminal && (
          <button
            type="button"
            onClick={handleReDelegate}
            disabled={busy}
            className="px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-colors hover:bg-zinc-800"
            style={{ border: "1px solid var(--border)", backgroundColor: "transparent", color: "var(--text-primary)", cursor: "pointer" }}
          >
            <RotateCcw className="w-3 h-3" /> Re-delegar (clone)
          </button>
        )}
      </div>

      {/* Inline send-note composer */}
      {!isTerminal && task.assigned_to && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNoteUrgent((u) => !u)}
            title={
              noteUrgent
                ? "Direct: interrompe agente agora"
                : "Queued Note: entrega no próximo checkpoint"
            }
            className="px-2.5 py-1.5 rounded text-[11px] font-semibold"
            style={{
              backgroundColor: noteUrgent ? "#dc2626" : "#eab308",
              color: "white",
              border: "none",
              cursor: "pointer",
            }}
          >
            {noteUrgent ? "🔴 Direct" : "🟡 Queued"}
          </button>
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSendNote();
              }
            }}
            placeholder={noteUrgent ? "Mensagem direta" : "Nota (próximo checkpoint)"}
            className="flex-1 px-2.5 py-1.5 rounded text-[11px] outline-none bg-zinc-900 border text-white"
            style={{ borderColor: "var(--border)" }}
          />
          <button
            type="button"
            onClick={handleSendNote}
            disabled={busy || !noteDraft.trim()}
            className="p-1.5 rounded disabled:opacity-50 hover:scale-105 transition-all"
            style={{ backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Chat / checkpoints split */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72">
        <div>
          <div className="text-[10px] font-bold uppercase text-zinc-400 mb-1">Mensagens ({messages.length})</div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {messages.length === 0 && <div className="text-[10px] text-zinc-500">—</div>}
            {messages.map((m) => (
              <div
                key={m.id}
                className="text-[10px] rounded p-1.5"
                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
              >
                <div className="flex justify-between mb-0.5">
                  <span className="text-zinc-500">
                    {m.from_agent_id || "user"} → {m.to_agent_id} ({m.message_type})
                  </span>
                  <span className="text-zinc-600">{new Date(m.created_at).toLocaleTimeString()}</span>
                </div>
                <div className="text-zinc-200 whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase text-zinc-400 mb-1">
            Checkpoints ({checkpoints.length})
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {checkpoints.length === 0 && <div className="text-[10px] text-zinc-500">—</div>}
            {checkpoints.map((c) => (
              <div
                key={c.id}
                className="text-[10px] rounded p-1.5"
                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
              >
                <div className="flex justify-between mb-0.5">
                  <span className="text-zinc-500">{c.agent_id}</span>
                  <span className="text-zinc-600">{new Date(c.created_at).toLocaleTimeString()}</span>
                </div>
                <pre className="text-zinc-300 whitespace-pre-wrap break-words font-mono text-[10px]">
                  {JSON.stringify(c.checkpoint_data, null, 2).slice(0, 200)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
