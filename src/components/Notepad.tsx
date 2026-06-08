"use client";

import { useState, useEffect, useRef } from "react";
import { StickyNote, Trash2, Maximize2 } from "lucide-react";
import Link from "next/link";

const STORAGE_KEY = "atlasdeck-notepad";

export function Notepad() {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const initializedRef = useRef(false);
  const skipSaveRef = useRef(false);

  // Load the quick note from the database on mount.
  // Migrates a pre-existing localStorage note into the DB one time.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/notes/quick");
        const data = await res.json();
        if (data.note && data.note.content) {
          skipSaveRef.current = true;
          setText(data.note.content);
          setLastSaved(data.note.updated_at ? new Date(data.note.updated_at) : null);
        } else {
          // One-time migration of the legacy localStorage scratchpad
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              const legacy = parsed.text || "";
              if (legacy.trim()) {
                skipSaveRef.current = true;
                setText(legacy);
                await fetch("/api/notes/quick", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content: legacy }),
                });
                setLastSaved(new Date());
              }
            } catch {}
            localStorage.removeItem(STORAGE_KEY);
          }
        }
      } catch {}
      initializedRef.current = true;
    })();
  }, []);

  // Auto-save after 2 seconds of no typing
  useEffect(() => {
    if (!initializedRef.current) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaved(false);
    saveTimerRef.current = setTimeout(() => {
      save();
    }, 2000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [text]);

  const save = async () => {
    try {
      await fetch("/api/notes/quick", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      setSaved(true);
      setLastSaved(new Date());
    } catch {
      // Keep "salvando..." state so the user knows it didn't persist
    }
  };

  const clear = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    skipSaveRef.current = true;
    setText("");
    try {
      await fetch("/api/notes/quick", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      setSaved(true);
      setLastSaved(new Date());
    } catch {}
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      backgroundColor: "var(--card)",
      borderRadius: "0.75rem",
      border: "1px solid var(--border)",
      overflow: "hidden",
      height: "100%",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: "0.5rem",
        padding: "0.625rem 0.875rem",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <StickyNote className="w-3.5 h-3.5" style={{ color: "#fbbf24", flexShrink: 0 }} />
        <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", flex: 1, fontWeight: 500 }}>
          Bloco de Notas
        </span>
        {!saved && (
          <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>salvando...</span>
        )}
        {saved && lastSaved && (
          <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
            salvo às {lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <Link
          href="/notes"
          title="Ver todas as notas"
          style={{ padding: "0.2rem", borderRadius: "0.25rem", display: "inline-flex", color: "var(--text-muted)" }}
        >
          <Maximize2 className="w-3 h-3" />
        </Link>
        <button
          onClick={clear}
          title="Limpar"
          style={{ padding: "0.2rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Textarea */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Notas rápidas, lembretes, ideias..."
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          outline: "none",
          padding: "0.75rem",
          backgroundColor: "transparent",
          color: "var(--text-primary)",
          fontSize: "0.8rem",
          lineHeight: 1.6,
          fontFamily: "var(--font-body, sans-serif)",
          minHeight: "120px",
        }}
      />
    </div>
  );
}
