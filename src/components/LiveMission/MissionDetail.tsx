"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ThumbsUp,
  ThumbsDown,
  XCircle,
  RotateCcw,
  Send,
  Clock,
  DollarSign,
  Cpu,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  MessageSquare,
  GitBranch,
  Wrench,
} from "lucide-react";
import { DependencyGraph } from "./DependencyGraph";
import { TaskTimeline } from "./TaskTimeline";
import {
  STATUS_COLORS,
  STATUS_LABELS,
  STATUS_COLUMNS,
  formatElapsed,
  type AgentInfo,
  type Checkpoint,
  type LiveEvent,
  type MailMessage,
  type Task,
  type TaskStatus,
} from "./types";

interface Props {
  task: Task;
  allTasks: Task[];
  agents: AgentInfo[];
  onMutated: () => void;
  onSelectTask: (taskId: string) => void;
}

type DetailTab = "timeline" | "conversa" | "familia" | "tecnico";

/**
 * Center cockpit panel for the selected mission. Top-to-bottom priority:
 * approval (when the mission is waiting on the user), the deliverable
 * rendered as markdown, then tabs for the timeline / conversation /
 * task family / technical payloads.
 */
export function MissionDetail({ task, allTasks, agents, onMutated, onSelectTask }: Props) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [children, setChildren] = useState<Task[]>([]);
  const [tab, setTab] = useState<DetailTab>("timeline");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteUrgent, setNoteUrgent] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a]));
    return (id: string | null | undefined) => {
      if (!id) return "—";
      const a = m.get(id);
      return a ? `${a.emoji ?? "🤖"} ${a.name}` : id;
    };
  }, [agents]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
      setEvents(Array.isArray(data.events) ? data.events : []);
      setChildren(Array.isArray(data.children) ? data.children : []);
    } catch {
      // swallow — SSE will trigger another refresh soon enough
    }
  }, [task.id]);

  useEffect(() => {
    setNoteDraft("");
    setFeedback("");
    setResultExpanded(false);
    setPromptExpanded(false);
    refresh();
  }, [task.id, refresh]);

  // Refresh when the upstream task object mutates (SSE-driven).
  useEffect(() => {
    refresh();
  }, [task.status, task.cost_cents, refresh]);

  const handleAction = useCallback(
    async (label: string, run: () => Promise<Response>) => {
      setBusy(true);
      try {
        const res = await run();
        if (!res.ok) {
          console.error(`[mission-detail] ${label} failed:`, await res.text());
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

  const handleStatusOverride = (status: TaskStatus) =>
    handleAction(`status(${status})`, () =>
      fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
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
    const body = noteDraft.trim();
    if (!body) return;
    handleAction("send-note", () =>
      fetch(`/api/mailbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_agent_id: task.assigned_to,
          task_id: task.id,
          body,
          message_type: noteUrgent ? "direct_message" : "queued_note",
          from_agent_id: null,
        }),
      }),
    );
    setNoteDraft("");
  };

  const copyResult = async () => {
    if (!task.result) return;
    try {
      await navigator.clipboard.writeText(task.result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable over http — fail silently
    }
  };

  const color = STATUS_COLORS[task.status as keyof typeof STATUS_COLORS];
  const elapsedMs = task.completed_at
    ? new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()
    : Date.now() - new Date(task.created_at).getTime();
  const isReview = task.status === "review";
  const isTerminal = task.status === "done" || task.status === "cancelled" || task.status === "failed";
  const hasFamily =
    !!task.parent_task_id || task.depends_on.length > 0 || allTasks.some((t) => t.parent_task_id === task.id);
  const resultIsLong = (task.result?.length ?? 0) > 900;

  const TABS: Array<{ key: DetailTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { key: "timeline", label: "Linha do tempo", icon: <History className="w-3 h-3" /> },
    { key: "conversa", label: "Conversa", icon: <MessageSquare className="w-3 h-3" />, badge: messages.length },
    ...(hasFamily
      ? [{ key: "familia" as DetailTab, label: "Subtarefas", icon: <GitBranch className="w-3 h-3" />, badge: children.length }]
      : []),
    { key: "tecnico", label: "Técnico", icon: <Wrench className="w-3 h-3" />, badge: checkpoints.length },
  ];

  return (
    <div
      className="rounded-xl flex flex-col min-h-0 h-full"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* ───── Header ───── */}
      <div className="p-3 border-b space-y-2" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
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
                  ↑ ver missão-mãe
                </button>
              )}
              {/* Manual status override replaces kanban drag-and-drop */}
              {!isTerminal && (
                <select
                  value={task.status}
                  onChange={(e) => void handleStatusOverride(e.target.value as TaskStatus)}
                  disabled={busy}
                  className="text-[10px] bg-zinc-900 border rounded px-1.5 py-0.5 text-zinc-400 outline-none ml-auto"
                  style={{ borderColor: "var(--border)" }}
                  title="Mover manualmente para outra etapa"
                >
                  {STATUS_COLUMNS.map((s) => (
                    <option key={s} value={s}>
                      mover p/ {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <h3 className="text-base font-bold text-white leading-tight">
              {task.title || task.prompt.slice(0, 80)}
            </h3>
            <div className="text-[10px] text-zinc-400 mt-1 flex items-center gap-1.5 flex-wrap">
              <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/25">
                {task.delegated_by ? `${agentName(task.delegated_by)} → ${agentName(task.assigned_to)}` : `→ ${agentName(task.assigned_to)}`}
              </span>
              <span className="flex items-center gap-1 text-zinc-500">
                <Clock className="w-3 h-3" /> {formatElapsed(elapsedMs)}
              </span>
              <span className="flex items-center gap-1 text-zinc-500" title="custo acumulado">
                <DollarSign className="w-3 h-3" /> {task.cost_cents}¢
              </span>
              <span className="flex items-center gap-1 text-zinc-500" title="tokens entrada / saída">
                <Cpu className="w-3 h-3" /> {task.tokens_in}↓ {task.tokens_out}↑
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1 flex-shrink-0">
            {!isTerminal && (
              <button
                type="button"
                onClick={handleKill}
                disabled={busy}
                className="px-2.5 py-1 rounded text-[10px] font-semibold flex items-center gap-1 transition-colors hover:bg-red-950"
                style={{ border: "1px solid rgba(239,68,68,0.4)", backgroundColor: "rgba(239,68,68,0.10)", color: "#fca5a5", cursor: "pointer" }}
              >
                <XCircle className="w-3 h-3" /> Cancelar
              </button>
            )}
            {isTerminal && (
              <button
                type="button"
                onClick={handleReDelegate}
                disabled={busy}
                className="px-2.5 py-1 rounded text-[10px] font-semibold flex items-center gap-1 transition-colors hover:bg-zinc-800"
                style={{ border: "1px solid var(--border)", backgroundColor: "transparent", color: "var(--text-primary)", cursor: "pointer" }}
              >
                <RotateCcw className="w-3 h-3" /> Re-delegar
              </button>
            )}
          </div>
        </div>

        {/* Briefing (prompt) */}
        <div
          className="rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-400"
          style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
        >
          <button
            type="button"
            onClick={() => setPromptExpanded((v) => !v)}
            className="w-full text-left"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            <span className="text-[9px] font-bold uppercase text-zinc-500 mr-2">Briefing</span>
            <span className={`text-zinc-400 whitespace-pre-wrap ${promptExpanded ? "" : "line-clamp-2"}`}>
              {task.prompt}
            </span>
            {task.prompt.length > 160 && (
              <span className="text-[9px] text-blue-400 ml-1">{promptExpanded ? "▴ menos" : "▾ ler tudo"}</span>
            )}
          </button>
        </div>
      </div>

      {/* ───── Scrollable body ───── */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">
        {/* Approval — the single most important interaction, always on top */}
        {isReview && (
          <div
            className="space-y-2 rounded-lg p-3"
            style={{ backgroundColor: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.35)" }}
          >
            <div className="text-[12px] text-amber-300 font-bold flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              Esta entrega aguarda a sua decisão
            </div>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Seu feedback (opcional). Se rejeitar, isso vira instrução direta pro agente corrigir — quanto mais específico, melhor."
              rows={3}
              className="w-full px-2.5 py-2 rounded text-[12px] outline-none bg-zinc-900 border text-white resize-y"
              style={{ borderColor: "var(--border)" }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleApprove(true)}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all hover:scale-[1.02] disabled:opacity-50"
                style={{ backgroundColor: "#16a34a", color: "white", border: "none", cursor: "pointer" }}
              >
                <ThumbsUp className="w-4 h-4" /> Aprovar entrega
              </button>
              <button
                type="button"
                onClick={() => handleApprove(false)}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all hover:scale-[1.02] disabled:opacity-50"
                style={{ backgroundColor: "#dc2626", color: "white", border: "none", cursor: "pointer" }}
              >
                <ThumbsDown className="w-4 h-4" /> Devolver p/ correção
              </button>
            </div>
          </div>
        )}

        {/* Verdicts already given */}
        {task.review_notes && (
          <div
            className="rounded-lg p-2.5 text-[11px] text-amber-100 whitespace-pre-wrap"
            style={{ backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)" }}
          >
            <div className="text-[10px] font-bold uppercase text-amber-300 mb-1">
              Veredito do revisor: {task.review_verdict === "approved" ? "aprovado" : task.review_verdict === "rejected" ? "rejeitado" : task.review_verdict ?? "—"}
            </div>
            {task.review_notes}
          </div>
        )}
        {task.user_feedback && (
          <div
            className="rounded-lg p-2.5 text-[11px] text-zinc-200 whitespace-pre-wrap"
            style={{ backgroundColor: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)" }}
          >
            <div className="text-[10px] font-bold uppercase text-blue-300 mb-1">
              Seu feedback {task.user_approved === true ? "(aprovou 👍)" : task.user_approved === false ? "(rejeitou 👎)" : ""}
            </div>
            {task.user_feedback}
          </div>
        )}

        {/* Deliverable, rendered as markdown */}
        {task.result && (
          <div className="rounded-lg" style={{ backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between px-3 pt-2.5">
              <span className="text-[10px] font-bold uppercase text-zinc-500">📦 Entrega</span>
              <button
                type="button"
                onClick={copyResult}
                className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white transition-colors"
                style={{ background: "none", border: "none", cursor: "pointer" }}
                title="Copiar texto bruto"
              >
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {copied ? "copiado" : "copiar"}
              </button>
            </div>
            <div
              className={`px-3 pb-3 pt-1 overflow-y-auto ${resultIsLong && !resultExpanded ? "max-h-72" : "max-h-[60vh]"}`}
            >
              <div className="prose prose-invert prose-sm max-w-none prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-li:my-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.result}</ReactMarkdown>
              </div>
            </div>
            {resultIsLong && (
              <button
                type="button"
                onClick={() => setResultExpanded((v) => !v)}
                className="w-full flex items-center justify-center gap-1 py-1.5 text-[10px] font-semibold text-blue-400 hover:bg-zinc-800/60 transition-colors rounded-b-lg"
                style={{ background: "none", border: "none", borderTop: "1px solid var(--border)", cursor: "pointer" }}
              >
                {resultExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {resultExpanded ? "Recolher entrega" : "Expandir entrega completa"}
              </button>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b pb-0" style={{ borderColor: "var(--border)" }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-t transition-colors"
              style={{
                background: "none",
                border: "none",
                borderBottom: tab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
                color: tab === t.key ? "white" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {t.icon}
              {t.label}
              {typeof t.badge === "number" && t.badge > 0 && (
                <span className="text-[9px] text-zinc-500">({t.badge})</span>
              )}
            </button>
          ))}
        </div>

        {tab === "timeline" && (
          <TaskTimeline task={task} events={events} checkpoints={checkpoints} messages={messages} agents={agents} />
        )}

        {tab === "conversa" && (
          <div className="space-y-2">
            {messages.length === 0 && (
              <div className="text-[11px] text-zinc-500 text-center py-4">
                Nenhuma mensagem ainda. Use o campo abaixo pra falar com o agente.
              </div>
            )}
            {messages.map((m) => {
              const fromUser = !m.from_agent_id;
              return (
                <div key={m.id} className={`flex ${fromUser ? "justify-end" : "justify-start"}`}>
                  <div
                    className="max-w-[85%] rounded-lg px-3 py-2"
                    style={{
                      backgroundColor: fromUser ? "rgba(59,130,246,0.15)" : "rgba(0,0,0,0.4)",
                      border: `1px solid ${fromUser ? "rgba(59,130,246,0.35)" : "var(--border)"}`,
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-3 mb-0.5">
                      <span className="text-[9px] font-semibold text-zinc-400">
                        {fromUser ? "Você" : agentName(m.from_agent_id)} → {agentName(m.to_agent_id)}
                        <span className="text-zinc-600 font-normal">
                          {" "}· {m.message_type === "direct_message" ? "direta" : m.message_type === "queued_note" ? "nota" : m.message_type === "review_feedback" ? "revisão" : "entre agentes"}
                        </span>
                      </span>
                      <span className="text-[9px] text-zinc-600 flex-shrink-0">
                        {new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <div className="text-[12px] text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                      {m.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "familia" && hasFamily && (
          <div className="space-y-2">
            <DependencyGraph tasks={allTasks} selectedTaskId={task.id} onSelectTask={onSelectTask} />
            {children.length > 0 && (
              <div className="space-y-1">
                {children.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSelectTask(c.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-zinc-800/60 transition-colors"
                    style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", cursor: "pointer" }}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: STATUS_COLORS[c.status as TaskStatus] }}
                    />
                    <span className="text-[11px] text-zinc-200 truncate flex-1">{c.title || c.prompt.slice(0, 60)}</span>
                    <span className="text-[9px] text-zinc-500 flex-shrink-0">
                      {STATUS_LABELS[c.status as TaskStatus]} · {agentName(c.assigned_to)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "tecnico" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-400">
              <Info label="Criada em" value={new Date(task.created_at).toLocaleString("pt-BR")} />
              <Info label="Iniciada em" value={task.started_at ? new Date(task.started_at).toLocaleString("pt-BR") : "—"} />
              <Info label="Concluída em" value={task.completed_at ? new Date(task.completed_at).toLocaleString("pt-BR") : "—"} />
              <Info label="Workspace" value={task.workspace_path ?? "—"} mono />
              <Info label="ID completo" value={task.id} mono />
              <Info label="Depende de" value={task.depends_on.length ? task.depends_on.map((d) => d.slice(0, 8)).join(", ") : "—"} mono />
            </div>
            {task.metadata && Object.keys(task.metadata).length > 0 && (
              <pre
                className="text-[10px] text-zinc-300 p-2 rounded whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto"
                style={{ backgroundColor: "rgba(0,0,0,0.45)", border: "1px solid var(--border)" }}
              >
                {JSON.stringify(task.metadata, null, 2)}
              </pre>
            )}
            <div className="text-[10px] font-bold uppercase text-zinc-500">Checkpoints ({checkpoints.length})</div>
            {checkpoints.length === 0 && <div className="text-[10px] text-zinc-600">—</div>}
            {checkpoints.map((c) => (
              <div
                key={c.id}
                className="text-[10px] rounded p-2"
                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
              >
                <div className="flex justify-between mb-1 text-zinc-500">
                  <span>{agentName(c.agent_id)}</span>
                  <span>{new Date(c.created_at).toLocaleString("pt-BR")}</span>
                </div>
                <pre className="text-zinc-300 whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">
                  {JSON.stringify(c.checkpoint_data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ───── Composer (pinned to bottom) ───── */}
      {!isTerminal && task.assigned_to && (
        <div className="p-2.5 border-t flex items-end gap-2" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setNoteUrgent((u) => !u)}
            title={
              noteUrgent
                ? "Direta: interrompe o agente agora mesmo"
                : "Nota: entregue no próximo checkpoint, sem interromper"
            }
            className="px-2.5 py-2 rounded-lg text-[10px] font-bold flex-shrink-0"
            style={{
              backgroundColor: noteUrgent ? "#dc2626" : "#a16207",
              color: "white",
              border: "none",
              cursor: "pointer",
            }}
          >
            {noteUrgent ? "🔴 Direta" : "🟡 Nota"}
          </button>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSendNote();
              }
            }}
            rows={2}
            placeholder={`Falar com ${agentName(task.assigned_to)}… (${noteUrgent ? "interrompe agora" : "entrega no próximo checkpoint"} · Ctrl+Enter envia)`}
            className="flex-1 px-2.5 py-2 rounded-lg text-[12px] outline-none bg-zinc-900 border text-white resize-none"
            style={{ borderColor: "var(--border)" }}
          />
          <button
            type="button"
            onClick={handleSendNote}
            disabled={busy || !noteDraft.trim()}
            className="p-2.5 rounded-lg disabled:opacity-40 hover:scale-105 transition-all flex-shrink-0"
            style={{ backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}
            title="Enviar (Ctrl+Enter)"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded p-1.5" style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}>
      <div className="text-[9px] font-bold uppercase text-zinc-600">{label}</div>
      <div className={`text-zinc-300 break-all ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
