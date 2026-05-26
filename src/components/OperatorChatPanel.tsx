"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Send,
  Zap,
  Clock,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  X,
} from "lucide-react";

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  delegated_by: string | null;
  cost_cents: number;
  created_at: string;
  result: string | null;
  user_approved: boolean | null;
}

interface MailMessage {
  id: string;
  task_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string;
  subject: string | null;
  body: string;
  message_type: "queued_note" | "direct_message" | "inter_agent" | "review_feedback";
  created_at: string;
  read_at: string | null;
}

const ACTIVE_STATUSES = ["planning", "inbox", "assigned", "in_progress", "testing", "review"];

/**
 * Persistent operator chat — lives on `/agents` regardless of which tab the
 * user is on. Lists tasks in flight on the left, a per-task conversation on
 * the right, with two message modes:
 *   - 🟡 Queued Note (delivered at the agent's next checkpoint)
 *   - 🔴 Direct (broadcast immediately — interrupts the agent's loop)
 *
 * Tasks in `review` status get 👍 / 👎 buttons inline so the human can
 * finalize without leaving the panel.
 */
export function OperatorChatPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const conversationEnd = useRef<HTMLDivElement | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks?status=${ACTIVE_STATUSES.join(",")}&limit=50`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    } catch {
      // swallow
    }
  }, []);

  const fetchMessages = useCallback(async (taskId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
      if (!res.ok) {
        setMessages([]);
        return;
      }
      const data = await res.json();
      setMessages(Array.isArray(data?.messages) ? data.messages : []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + polling load. 4s strikes a balance between responsiveness and
  // load — the dedicated Live Mission SSE stream (Fase 3) will replace it.
  useEffect(() => {
    if (collapsed) return;
    fetchTasks();
    const t = setInterval(fetchTasks, 4000);
    return () => clearInterval(t);
  }, [collapsed, fetchTasks]);

  useEffect(() => {
    if (collapsed || !selectedId) return;
    fetchMessages(selectedId);
    const t = setInterval(() => fetchMessages(selectedId), 4000);
    return () => clearInterval(t);
  }, [collapsed, selectedId, fetchMessages]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // Auto-select first task when opening the panel for the first time
  useEffect(() => {
    if (!collapsed && !selectedId && tasks.length > 0) {
      setSelectedId(tasks[0].id);
    }
  }, [collapsed, selectedId, tasks]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const handleSend = useCallback(async () => {
    if (!selectedTask || !draft.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_agent_id: selectedTask.assigned_to,
          task_id: selectedTask.id,
          message_type: urgent ? "direct_message" : "queued_note",
          body: draft.trim(),
          from_agent_id: null, // human user
        }),
      });
      if (res.ok) {
        setDraft("");
        await fetchMessages(selectedTask.id);
      }
    } finally {
      setBusy(false);
    }
  }, [selectedTask, draft, urgent, fetchMessages]);

  const handleApprove = useCallback(
    async (approved: boolean) => {
      if (!selectedTask) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/tasks/${selectedTask.id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved, feedback: feedback.trim() || undefined }),
        });
        if (res.ok) {
          setFeedback("");
          await Promise.all([fetchTasks(), fetchMessages(selectedTask.id)]);
        }
      } finally {
        setBusy(false);
      }
    },
    [selectedTask, feedback, fetchTasks, fetchMessages],
  );

  const handleRefresh = useCallback(async () => {
    setBusy(true);
    try {
      // Kick the dispatcher (idempotent) so any unblocked inbox tasks move
      // forward, then re-fetch.
      await fetch("/api/dispatcher/run", { method: "POST" }).catch(() => {});
      await fetchTasks();
      if (selectedId) await fetchMessages(selectedId);
    } finally {
      setBusy(false);
    }
  }, [fetchTasks, fetchMessages, selectedId]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-6 right-6 z-40 rounded-full p-3 shadow-2xl flex items-center gap-2 hover:scale-105 transition-all"
        style={{
          backgroundColor: "var(--accent)",
          color: "white",
          border: "none",
          cursor: "pointer",
        }}
        aria-label="Abrir Operator Chat"
      >
        <MessageSquare className="w-5 h-5" />
        {tasks.length > 0 && (
          <span className="text-xs font-bold bg-black/30 px-2 py-0.5 rounded-full">
            {tasks.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-6 right-6 z-40 w-[640px] max-w-[95vw] h-[560px] max-h-[80vh] flex rounded-2xl shadow-2xl overflow-hidden"
      style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)" }}
    >
      {/* Left rail: task list */}
      <div
        className="w-[220px] border-r flex flex-col"
        style={{ borderColor: "var(--border)", backgroundColor: "rgba(0,0,0,0.25)" }}
      >
        <div
          className="px-3 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
            Em voo ({tasks.length})
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={busy}
            className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 disabled:opacity-50"
            style={{ background: "none", border: "none", cursor: "pointer" }}
            aria-label="Atualizar"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {tasks.length === 0 && (
            <div className="text-center py-8 text-xs text-zinc-500 px-3">
              Nenhuma task em voo. Delegue algo pelo chat ou via{" "}
              <code className="text-[10px] px-1 py-0.5 rounded bg-zinc-800">/api/tasks/delegate</code>.
            </div>
          )}
          {tasks.map((t) => {
            const isSelected = t.id === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className="w-full text-left px-2.5 py-2 rounded-md mb-1 transition-colors"
                style={{
                  backgroundColor: isSelected ? "rgba(59,130,246,0.15)" : "transparent",
                  border: `1px solid ${isSelected ? "rgba(59,130,246,0.4)" : "transparent"}`,
                  cursor: "pointer",
                }}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span
                    className="text-[10px] font-bold uppercase"
                    style={{ color: statusColor(t.status) }}
                  >
                    {t.status}
                  </span>
                  <span className="text-[10px] text-zinc-500 truncate">→ {t.assigned_to ?? "?"}</span>
                </div>
                <div className="text-xs text-white truncate" title={t.title}>
                  {t.title || "(sem título)"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right pane: conversation + composer */}
      <div className="flex-1 flex flex-col min-w-0">
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-zinc-500" />
              <span className="text-sm font-semibold text-white truncate">
                {selectedTask?.title ?? "Operator Chat"}
              </span>
            </div>
            {selectedTask && (
              <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
                {selectedTask.id.slice(0, 8)} · {selectedTask.cost_cents}¢ · {selectedTask.assigned_to ?? "?"}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
            style={{ background: "none", border: "none", cursor: "pointer" }}
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Conversation */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {!selectedTask && (
            <div className="text-center py-8 text-xs text-zinc-500">
              Selecione uma task à esquerda pra abrir a conversa.
            </div>
          )}
          {selectedTask && loading && messages.length === 0 && (
            <div className="text-center py-8 text-xs text-zinc-500">Carregando...</div>
          )}
          {selectedTask && messages.length === 0 && !loading && (
            <div className="text-center py-8 text-xs text-zinc-500">
              Nenhuma mensagem nesta task ainda.
            </div>
          )}
          {messages.map((m) => {
            const from = m.from_agent_id || "user";
            const isHuman = from === "user" || from === null;
            const tag = m.message_type === "direct_message"
              ? { icon: "🔴", label: "DIRECT" }
              : m.message_type === "queued_note"
              ? { icon: "🟡", label: "QUEUED" }
              : m.message_type === "review_feedback"
              ? { icon: "🛡️", label: "REVIEW" }
              : { icon: "↔️", label: "INTER" };
            return (
              <div
                key={m.id}
                className="px-3 py-2 rounded-lg text-xs"
                style={{
                  backgroundColor: isHuman ? "rgba(59,130,246,0.10)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${isHuman ? "rgba(59,130,246,0.25)" : "var(--border)"}`,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    {tag.icon} {tag.label}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {isHuman ? "🧑 você" : `🤖 ${from}`}
                  </span>
                  <span className="text-[10px] text-zinc-600 ml-auto">
                    {new Date(m.created_at).toLocaleTimeString()}
                  </span>
                </div>
                {m.subject && (
                  <div className="text-[11px] font-semibold text-zinc-300 mb-0.5">{m.subject}</div>
                )}
                <div className="text-xs text-white whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            );
          })}
          <div ref={conversationEnd} />
        </div>

        {/* Approval panel when task is in review */}
        {selectedTask?.status === "review" && (
          <div
            className="px-4 py-3 border-t space-y-2"
            style={{ borderColor: "var(--border)", backgroundColor: "rgba(245,158,11,0.08)" }}
          >
            <div className="text-[11px] text-amber-300 font-semibold">
              Aguardando seu 👍 / 👎 — orquestrador já aprovou; revise o resultado abaixo.
            </div>
            {selectedTask.result && (
              <div className="text-[11px] text-zinc-300 whitespace-pre-wrap line-clamp-4 max-h-24 overflow-y-auto p-2 rounded bg-zinc-900/60 border" style={{ borderColor: "var(--border)" }}>
                {selectedTask.result}
              </div>
            )}
            <input
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Comentário (opcional)"
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

        {/* Composer */}
        {selectedTask && selectedTask.status !== "done" && selectedTask.status !== "cancelled" && (
          <div
            className="px-3 py-2 border-t flex items-center gap-2"
            style={{ borderColor: "var(--border)" }}
          >
            <button
              type="button"
              onClick={() => setUrgent((u) => !u)}
              title={
                urgent
                  ? "Direct: interrompe agente agora"
                  : "Queued Note: entrega no próximo checkpoint"
              }
              className="p-2 rounded text-xs font-semibold transition-colors"
              style={{
                backgroundColor: urgent ? "#dc2626" : "#eab308",
                color: "white",
                border: "none",
                cursor: "pointer",
              }}
            >
              {urgent ? <Zap className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
            </button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                urgent ? "Mensagem direta (interrompe agora)" : "Nota (entrega no próximo checkpoint)"
              }
              className="flex-1 px-3 py-2 rounded text-xs outline-none bg-zinc-900 border text-white"
              style={{ borderColor: "var(--border)" }}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={busy || !draft.trim()}
              className="p-2 rounded disabled:opacity-50 hover:scale-105 transition-all"
              style={{ backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "planning":
      return "#a78bfa";
    case "inbox":
      return "#94a3b8";
    case "assigned":
      return "#3b82f6";
    case "in_progress":
      return "#0ea5e9";
    case "testing":
      return "#eab308";
    case "review":
      return "#f97316";
    case "done":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    default:
      return "#71717a";
  }
}

/** Re-exported for parents that want to render their own toggle. */
export { ChevronDown, ChevronUp };
