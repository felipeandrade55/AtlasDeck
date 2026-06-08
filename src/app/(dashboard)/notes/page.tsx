"use client";

import { useEffect, useState, useMemo } from "react";
import {
  StickyNote,
  Plus,
  Trash2,
  Search,
  ArrowLeft,
  Loader2,
  Pin,
  PinOff,
  Check,
  X,
  Palette,
} from "lucide-react";
import Link from "next/link";

interface Note {
  id: string;
  title: string;
  content: string;
  color: string;
  pinned: boolean;
  is_quick: boolean;
  created_at: string;
  updated_at: string;
}

// Color palette: subtle backgrounds compatible with the dark theme.
const COLORS: { key: string; bg: string; label: string }[] = [
  { key: "default", bg: "var(--card-elevated)", label: "Padrão" },
  { key: "amber", bg: "rgba(251,191,36,0.12)", label: "Âmbar" },
  { key: "green", bg: "rgba(74,222,128,0.12)", label: "Verde" },
  { key: "blue", bg: "rgba(59,130,246,0.12)", label: "Azul" },
  { key: "rose", bg: "rgba(244,63,94,0.12)", label: "Rosa" },
  { key: "purple", bg: "rgba(168,85,247,0.12)", label: "Roxo" },
];

const colorBg = (key: string) =>
  COLORS.find((c) => c.key === key)?.bg ?? COLORS[0].bg;

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // New note form
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newColor, setNewColor] = useState("default");

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editColor, setEditColor] = useState("default");

  const fetchNotes = async () => {
    try {
      const res = await fetch("/api/notes");
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes || []);
      }
    } catch (err) {
      console.error("Failed to fetch notes:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotes();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() && !newContent.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          content: newContent,
          color: newColor,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotes((prev) => [data.note, ...prev]);
        setNewTitle("");
        setNewContent("");
        setNewColor("default");
      }
    } catch (err) {
      console.error("Failed to add note:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const patchNote = async (id: string, patch: Partial<Note>) => {
    const original = [...notes];
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setNotes(original);
      } else {
        const data = await res.json();
        setNotes((prev) => prev.map((n) => (n.id === id ? data.note : n)));
      }
    } catch (err) {
      console.error("Failed to update note:", err);
      setNotes(original);
    }
  };

  const handleTogglePin = (note: Note) =>
    patchNote(note.id, { pinned: !note.pinned });

  const handleColor = (note: Note, color: string) =>
    patchNote(note.id, { color });

  const handleDelete = async (id: string) => {
    const original = [...notes];
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
      if (!res.ok) setNotes(original);
    } catch (err) {
      console.error("Failed to delete note:", err);
      setNotes(original);
    }
  };

  const startEditing = (note: Note) => {
    setEditingId(note.id);
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditColor(note.color);
  };

  const handleSaveEdit = async (id: string) => {
    await patchNote(id, {
      title: editTitle.trim(),
      content: editContent,
      color: editColor,
    });
    setEditingId(null);
  };

  const filteredNotes = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(term) ||
        n.content.toLowerCase().includes(term)
    );
  }, [notes, search]);

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleDateString([], { day: "2-digit", month: "short" });
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
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
              fontFamily: "var(--font-heading)",
              color: "var(--text-primary)",
              letterSpacing: "-1.5px",
            }}
          >
            📝 Minhas Notas
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
            Crie, organize e edite todas as suas anotações em um só lugar.
          </p>
        </div>
      </div>

      {/* Create note */}
      <form
        onSubmit={handleAdd}
        className="rounded-2xl overflow-hidden p-5 md:p-6 mb-6 shadow-xl"
        style={{
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <input
          type="text"
          placeholder="Título"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="w-full mb-3 px-1 py-1 outline-none bg-transparent font-bold text-lg"
          style={{ color: "var(--text-primary)" }}
          disabled={submitting}
        />
        <textarea
          placeholder="Escreva uma nota..."
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={3}
          className="w-full px-1 py-1 outline-none bg-transparent resize-none text-sm"
          style={{ color: "var(--text-primary)", lineHeight: 1.6 }}
          disabled={submitting}
        />
        <div className="flex items-center justify-between gap-3 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-1.5">
            <Palette className="w-4 h-4 mr-1" style={{ color: "var(--text-muted)" }} />
            {COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setNewColor(c.key)}
                title={c.label}
                className="w-5 h-5 rounded-full transition-transform hover:scale-110 cursor-pointer"
                style={{
                  backgroundColor: c.bg,
                  border:
                    newColor === c.key
                      ? "2px solid var(--accent)"
                      : "1px solid var(--border)",
                }}
              />
            ))}
          </div>
          <button
            type="submit"
            disabled={submitting || (!newTitle.trim() && !newContent.trim())}
            className="px-5 py-2.5 rounded-xl font-bold transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer hover:opacity-90"
            style={{ backgroundColor: "var(--accent)", color: "#ffffff" }}
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
      </form>

      {/* Search */}
      <div className="relative w-full md:w-72 mb-6">
        <Search className="w-4 h-4 absolute left-3 top-3.5" style={{ color: "var(--text-muted)" }} />
        <input
          type="text"
          placeholder="Buscar notas..."
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

      {/* Notes grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
          <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Carregando suas notas...
          </p>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 rounded-full mb-4" style={{ backgroundColor: "rgba(251,191,36,0.1)" }}>
            <StickyNote className="w-8 h-8" style={{ color: "#fbbf24" }} />
          </div>
          <h3 className="font-bold text-lg mb-1" style={{ color: "var(--text-primary)" }}>
            {search.trim() ? "Nenhuma nota encontrada" : "Nenhuma nota ainda"}
          </h3>
          <p className="text-sm max-w-xs" style={{ color: "var(--text-secondary)" }}>
            {search.trim()
              ? "Tente alterar os termos da busca."
              : "Crie sua primeira nota usando o campo acima."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((note) => {
            const isEditing = note.id === editingId;
            return (
              <div
                key={note.id}
                className="rounded-xl p-4 transition-all group flex flex-col"
                style={{
                  backgroundColor: colorBg(note.color),
                  border: "1px solid var(--border)",
                }}
              >
                {isEditing ? (
                  <>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="Título"
                      className="w-full mb-2 px-1 py-1 outline-none bg-transparent font-bold"
                      style={{ color: "var(--text-primary)" }}
                    />
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={4}
                      placeholder="Escreva uma nota..."
                      className="w-full px-1 py-1 outline-none bg-transparent resize-none text-sm"
                      style={{ color: "var(--text-primary)", lineHeight: 1.6 }}
                    />
                    <div className="flex items-center justify-between gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                      <div className="flex items-center gap-1">
                        {COLORS.map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            onClick={() => setEditColor(c.key)}
                            title={c.label}
                            className="w-4 h-4 rounded-full transition-transform hover:scale-110 cursor-pointer"
                            style={{
                              backgroundColor: c.bg,
                              border:
                                editColor === c.key
                                  ? "2px solid var(--accent)"
                                  : "1px solid var(--border)",
                            }}
                          />
                        ))}
                      </div>
                      <div className="flex gap-1 items-center">
                        <button
                          onClick={() => handleSaveEdit(note.id)}
                          className="p-1.5 rounded-lg transition-all hover:bg-emerald-500/10 cursor-pointer"
                          style={{ color: "#4ade80", border: "none", background: "none" }}
                          title="Salvar"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-1.5 rounded-lg transition-all hover:bg-white/5 cursor-pointer"
                          style={{ color: "var(--text-muted)", border: "none", background: "none" }}
                          title="Cancelar"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3
                        className="font-bold text-sm break-words flex-1 min-w-0 cursor-pointer"
                        style={{ color: "var(--text-primary)" }}
                        onClick={() => startEditing(note)}
                      >
                        {note.title || (
                          <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                            (sem título)
                          </span>
                        )}
                      </h3>
                      <button
                        onClick={() => handleTogglePin(note)}
                        className="p-1 rounded-lg transition-all hover:bg-white/5 cursor-pointer shrink-0"
                        style={{
                          color: note.pinned ? "var(--accent)" : "var(--text-muted)",
                          border: "none",
                          background: "none",
                        }}
                        title={note.pinned ? "Desafixar" : "Fixar"}
                      >
                        {note.pinned ? <Pin className="w-4 h-4 fill-current" /> : <PinOff className="w-4 h-4" />}
                      </button>
                    </div>

                    {note.is_quick && (
                      <span
                        className="inline-flex items-center gap-1 self-start mb-2 px-2 py-0.5 rounded text-[0.6rem] font-bold"
                        style={{ backgroundColor: "rgba(251,191,36,0.15)", color: "#fbbf24" }}
                      >
                        <StickyNote className="w-2.5 h-2.5" /> Nota rápida
                      </span>
                    )}

                    <p
                      className="text-sm whitespace-pre-wrap break-words flex-1 cursor-pointer"
                      style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}
                      onClick={() => startEditing(note)}
                    >
                      {note.content || (
                        <span style={{ color: "var(--text-muted)" }}>(vazia)</span>
                      )}
                    </p>

                    {/* Footer row */}
                    <div className="flex items-center justify-between gap-2 mt-3 pt-2" style={{ borderTop: "1px solid var(--border)" }}>
                      <span className="text-[0.65rem] font-mono" style={{ color: "var(--text-muted)" }}>
                        {formatDate(note.updated_at)}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {COLORS.map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            onClick={() => handleColor(note, c.key)}
                            title={c.label}
                            className="w-3.5 h-3.5 rounded-full transition-transform hover:scale-110 cursor-pointer"
                            style={{
                              backgroundColor: c.bg,
                              border:
                                note.color === c.key
                                  ? "2px solid var(--accent)"
                                  : "1px solid var(--border)",
                            }}
                          />
                        ))}
                        <button
                          onClick={() => handleDelete(note.id)}
                          className="p-1 rounded-lg transition-all hover:bg-red-500/10 cursor-pointer ml-1"
                          style={{ color: "var(--error)", border: "none", background: "none" }}
                          title="Excluir nota"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
