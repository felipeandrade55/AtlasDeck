"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { 
  Bell, 
  Plus, 
  Trash2, 
  CheckCircle, 
  Circle, 
  Calendar, 
  Search, 
  Sparkles, 
  Clock, 
  ArrowLeft,
  Loader2,
  AlertCircle,
  Edit2,
  Check,
  X
} from "lucide-react";
import Link from "next/link";

interface Reminder {
  id: string;
  text: string;
  completed: boolean;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

type FilterType = "all" | "active" | "completed";

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("active");
  const [submitting, setSubmitting] = useState(false);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editDueAt, setEditDueAt] = useState("");
  const router = useRouter();

  // Load reminders
  const fetchReminders = async () => {
    try {
      const res = await fetch("/api/reminders");
      if (res.ok) {
        const data = await res.json();
        setReminders(data.reminders || []);
      }
    } catch (err) {
      console.error("Failed to fetch reminders:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReminders();
  }, []);

  // Add a reminder
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setReminders((prev) => [data.reminder, ...prev]);
        setText("");
        setDueAt("");
      }
    } catch (err) {
      console.error("Failed to add reminder:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Toggle reminder completion
  const handleToggle = async (id: string, currentStatus: boolean) => {
    // Optimistic UI update
    setReminders((prev) =>
      prev.map((r) => (r.id === id ? { ...r, completed: !currentStatus } : r))
    );

    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !currentStatus }),
      });
      if (!res.ok) {
        // Rollback
        setReminders((prev) =>
          prev.map((r) => (r.id === id ? { ...r, completed: currentStatus } : r))
        );
      }
    } catch (err) {
      console.error("Failed to toggle reminder:", err);
      // Rollback
      setReminders((prev) =>
        prev.map((r) => (r.id === id ? { ...r, completed: currentStatus } : r))
      );
    }
  };

  // Delete reminder
  const handleDelete = async (id: string) => {
    const original = [...reminders];
    setReminders((prev) => prev.filter((r) => r.id !== id));

    try {
      const res = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setReminders(original);
      }
    } catch (err) {
      console.error("Failed to delete reminder:", err);
      setReminders(original);
    }
  };

  // Format date helper for input type="datetime-local"
  const formatForInput = (isoString: string | null) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    const pad = (num: number) => String(num).padStart(2, "0");
    const yyyy = date.getFullYear();
    const MM = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
  };

  // Start inline editing
  const startEditing = (reminder: Reminder) => {
    setEditingId(reminder.id);
    setEditText(reminder.text);
    setEditDueAt(formatForInput(reminder.due_at));
  };

  // Save inline edit
  const handleSaveEdit = async (id: string) => {
    if (!editText.trim()) return;

    // Optimistically update
    setReminders((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              text: editText.trim(),
              due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
            }
          : r
      )
    );
    setEditingId(null);

    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: editText.trim(),
          due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
        }),
      });

      if (!res.ok) {
        // Rollback
        fetchReminders();
      }
    } catch (err) {
      console.error("Failed to save reminder edit:", err);
      fetchReminders();
    }
  };

  // Filtering and Searching
  const filteredReminders = useMemo(() => {
    return reminders
      .filter((r) => {
        if (filter === "active") return !r.completed;
        if (filter === "completed") return r.completed;
        return true;
      })
      .filter((r) =>
        r.text.toLowerCase().includes(search.toLowerCase())
      );
  }, [reminders, filter, search]);

  const activeCount = useMemo(() => reminders.filter((r) => !r.completed).length, [reminders]);
  const completedCount = useMemo(() => reminders.filter((r) => r.completed).length, [reminders]);

  const formatDueDate = (isoString: string | null) => {
    if (!isoString) return null;
    const date = new Date(isoString);
    const isToday = date.toDateString() === new Date().toDateString();
    const isPast = date.getTime() < Date.now();
    
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    
    return {
      label: isToday ? `Hoje às ${timeStr}` : `${dateStr} às ${timeStr}`,
      isPast: isPast && !isToday
    };
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <Link 
          href="/" 
          className="p-2 rounded-lg transition-all hover:bg-white/5"
          style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 
            className="text-2xl md:text-3xl font-bold mb-1"
            style={{ 
              fontFamily: 'var(--font-heading)',
              color: 'var(--text-primary)',
              letterSpacing: '-1.5px'
            }}
          >
            🔔 Central de Lembretes
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Gerencie anotações rápidas e prazos integrados com o robô do sistema.
          </p>
        </div>
      </div>

      {/* Main glassmorphism container */}
      <div 
        className="rounded-2xl overflow-hidden p-6 md:p-8 mb-6 shadow-2xl transition-all"
        style={{
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Creator Input Section */}
        <form onSubmit={handleAdd} className="space-y-4 mb-8">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="flex-1 relative">
              <input
                type="text"
                placeholder="Lembrar de pagar a conta X, corrigir bug, etc..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full pl-4 pr-4 py-3 rounded-xl outline-none font-medium transition-all"
                style={{
                  backgroundColor: "var(--card-elevated)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
                disabled={submitting}
              />
            </div>
            
            <div className="flex gap-2">
              <div className="relative flex items-center">
                <input
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="px-4 py-3 rounded-xl outline-none text-xs font-semibold font-mono transition-all cursor-pointer"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                  }}
                  disabled={submitting}
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !text.trim()}
                className="px-5 py-3 rounded-xl font-bold transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer hover:opacity-90"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "#ffffff",
                }}
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    <span>Adicionar</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Filters and Search Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 mb-6" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex gap-1.5 p-1 rounded-xl" style={{ backgroundColor: "var(--surface-elevated)" }}>
            {[
              { id: "active", label: "Pendentes", count: activeCount },
              { id: "completed", label: "Concluídos", count: completedCount },
              { id: "all", label: "Todos", count: reminders.length }
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setFilter(t.id as FilterType)}
                className="px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer"
                style={{
                  backgroundColor: filter === t.id ? "var(--card)" : "transparent",
                  color: filter === t.id ? "var(--text-primary)" : "var(--text-muted)",
                  border: filter === t.id ? "1px solid var(--border)" : "1px solid transparent",
                }}
              >
                {t.label} <span className="ml-1 opacity-60 font-mono">({t.count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-3.5" style={{ color: "var(--text-muted)" }} />
            <input
              type="text"
              placeholder="Buscar lembretes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl text-xs font-semibold outline-none transition-all"
              style={{
                backgroundColor: "var(--card-elevated)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
              }}
            />
          </div>
        </div>

        {/* Reminders List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Carregando seus lembretes...</p>
          </div>
        ) : filteredReminders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            {filter === "active" ? (
              <>
                <div className="p-4 rounded-full mb-4" style={{ backgroundColor: "rgba(74,222,128,0.1)" }}>
                  <Sparkles className="w-8 h-8" style={{ color: "#4ade80" }} />
                </div>
                <h3 className="font-bold text-lg mb-1" style={{ color: "var(--text-primary)" }}>Nenhum lembrete pendente!</h3>
                <p className="text-sm max-w-xs" style={{ color: "var(--text-secondary)" }}>
                  Tudo em dia! Peça ao OpenClaw pelo Telegram ou Chat para agendar novos lembretes.
                </p>
              </>
            ) : (
              <>
                <div className="p-4 rounded-full mb-4" style={{ backgroundColor: "var(--surface-elevated)" }}>
                  <Bell className="w-8 h-8" style={{ color: "var(--text-muted)" }} />
                </div>
                <h3 className="font-bold text-lg mb-1" style={{ color: "var(--text-primary)" }}>Nenhum lembrete encontrado</h3>
                <p className="text-sm max-w-xs" style={{ color: "var(--text-secondary)" }}>
                  Tente alterar seus termos de busca ou filtros de visualização.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
            {filteredReminders.map((reminder) => {
              const due = formatDueDate(reminder.due_at);
              const isEditing = reminder.id === editingId;
              return (
                <div
                  key={reminder.id}
                  className="flex items-center justify-between p-4 rounded-xl transition-all group hover:scale-[1.01]"
                  style={{
                    backgroundColor: "var(--card-elevated)",
                    border: "1px solid var(--border)",
                    opacity: reminder.completed ? 0.65 : 1,
                  }}
                >
                  {isEditing ? (
                    <div className="flex flex-col md:flex-row gap-3 flex-1 min-w-0 mr-3">
                      <input
                        type="text"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg outline-none font-medium transition-all text-sm"
                        style={{
                          backgroundColor: "var(--card)",
                          border: "1px solid var(--border)",
                          color: "var(--text-primary)",
                        }}
                      />
                      <input
                        type="datetime-local"
                        value={editDueAt}
                        onChange={(e) => setEditDueAt(e.target.value)}
                        className="px-3 py-2 rounded-lg outline-none text-xs font-semibold font-mono transition-all cursor-pointer"
                        style={{
                          backgroundColor: "var(--card)",
                          border: "1px solid var(--border)",
                          color: "var(--text-secondary)",
                        }}
                      />
                      <div className="flex gap-2 shrink-0 items-center justify-end">
                        <button
                          onClick={() => handleSaveEdit(reminder.id)}
                          disabled={!editText.trim()}
                          className="p-2 rounded-lg transition-all hover:bg-emerald-500/10 cursor-pointer"
                          style={{ color: "#4ade80", border: "none", background: "none" }}
                          title="Salvar"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-2 rounded-lg transition-all hover:bg-white/5 cursor-pointer"
                          style={{ color: "var(--text-muted)", border: "none", background: "none" }}
                          title="Cancelar"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3.5 flex-1 min-w-0">
                        <button
                          onClick={() => handleToggle(reminder.id, reminder.completed)}
                          className="transition-transform active:scale-95 cursor-pointer text-left"
                          style={{ background: "none", border: "none" }}
                        >
                          {reminder.completed ? (
                            <CheckCircle className="w-5 h-5" style={{ color: "#4ade80" }} />
                          ) : (
                            <Circle className="w-5 h-5" style={{ color: "var(--text-muted)" }} />
                          )}
                        </button>

                        <div className="flex flex-col gap-1 min-w-0">
                          <span 
                            className="font-medium text-sm break-words" 
                            style={{ 
                              color: "var(--text-primary)",
                              textDecoration: reminder.completed ? "line-through" : "none"
                            }}
                          >
                            {reminder.text}
                          </span>
                          
                          {due && (
                            <div className="flex items-center gap-1.5 text-xs font-semibold">
                              {due.isPast && !reminder.completed ? (
                                <div className="flex items-center gap-1 px-2 py-0.5 rounded" style={{ backgroundColor: "rgba(239,68,68,0.12)", color: "var(--error)" }}>
                                  <AlertCircle className="w-3.5 h-3.5" />
                                  <span>Atrasado ({due.label})</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 px-2 py-0.5 rounded" style={{ backgroundColor: "var(--surface-elevated)", color: "var(--text-muted)" }}>
                                  <Clock className="w-3.5 h-3.5" />
                                  <span>{due.label}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-1.5 shrink-0">
                        <button
                          onClick={() => startEditing(reminder)}
                          className="p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/5 cursor-pointer"
                          style={{ color: "var(--text-secondary)", border: "none", background: "none" }}
                          title="Editar lembrete"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleDelete(reminder.id)}
                          className="p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/10 cursor-pointer"
                          style={{ color: "var(--error)", border: "none", background: "none" }}
                          title="Excluir lembrete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Helpful Hint banner */}
      <div 
        className="rounded-xl p-4 flex gap-3 items-start"
        style={{
          backgroundColor: "rgba(59,130,246,0.06)",
          border: "1px solid rgba(59,130,246,0.12)",
        }}
      >
        <Sparkles className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "#3b82f6" }} />
        <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
          <strong style={{ color: "var(--text-primary)" }}>Integração por Inteligência Artificial:</strong>
          <p className="mt-1 leading-relaxed">
            Seu assistente virtual <strong>OpenClaw (Jarvis)</strong> está conectado a este banco de dados! 
            Você pode dizer <em>"Jarvis, lembre de pagar o provedor amanhã às 14h"</em> ou <em>"Anote um lembrete para corrigir a rota de login"</em> via <strong>Chat</strong> ou no aplicativo do <strong>Telegram</strong>. O Jarvis fará a inserção instantânea no painel.
          </p>
        </div>
      </div>
    </div>
  );
}
