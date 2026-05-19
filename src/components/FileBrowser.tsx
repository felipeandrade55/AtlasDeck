"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { format } from "date-fns";
import dynamic from "next/dynamic";
import {
  Folder,
  FileText,
  FileCode,
  FileJson,
  Image,
  File,
  Loader2,
  AlertCircle,
  FolderOpen,
  Upload,
  Download,
  Trash2,
  FolderPlus,
  FilePlus,
  X,
  Save,
  Eye,
  Code2,
  RefreshCw,
  Search,
  Scissors,
  ClipboardPaste,
  Pencil,
} from "lucide-react";
import { FilePreview } from "./FilePreview";

// Lazy-load Monaco editor to avoid SSR issues
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface FileEntry {
  name: string;
  type: "file" | "folder";
  size: number;
  modified: string;
}

interface FileBrowserProps {
  workspace: string;
  path: string;
  onNavigate: (path: string) => void;
  viewMode?: "grid" | "list";
}

function getFileIcon(name: string, type: string) {
  if (type === "folder") return Folder;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "py", "sh", "bash"].includes(ext)) return FileCode;
  if (["json", "yaml", "yml", "toml"].includes(ext)) return FileJson;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return Image;
  if (["md", "mdx", "txt", "log"].includes(ext)) return FileText;
  return File;
}

function getFileColor(name: string, type: string): string {
  if (type === "folder") return "#F59E0B";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx"].includes(ext)) return "#60A5FA";
  if (["js", "jsx"].includes(ext)) return "#FCD34D";
  if (["json"].includes(ext)) return "#4ADE80";
  if (["py"].includes(ext)) return "#93C5FD";
  if (["md", "mdx"].includes(ext)) return "var(--text-secondary)";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "#C084FC";
  return "var(--text-secondary)";
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getMonacoLanguage(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", mdx: "markdown", py: "python",
    sh: "shell", bash: "shell", yaml: "yaml", yml: "yaml",
    toml: "toml", css: "css", html: "html", sql: "sql",
    txt: "plaintext", log: "plaintext",
  };
  return map[ext] || "plaintext";
}

function isEditable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const editableExts = ["ts", "tsx", "js", "jsx", "json", "md", "mdx", "txt", "py", "sh", "yaml", "yml", "toml", "css", "html", "sql", "log", "env"];
  return editableExts.includes(ext) || !name.includes(".");
}

// ─── Monaco Editor Modal ───────────────────────────────────────────────────────
interface EditorModalProps {
  workspace: string;
  filePath: string;
  fileName: string;
  onClose: () => void;
}

function EditorModal({ workspace, filePath, fileName, onClose }: EditorModalProps) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/browse?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}&content=true`)
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content || "");
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load file");
        setLoading(false);
      });
  }, [workspace, filePath]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Create .bak backup before saving
      await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path: `${filePath}.bak`, content }),
      }).catch(() => { /* backup is best-effort */ });

      const res = await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path: filePath, content }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Failed to save file");
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut: Ctrl/Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [content]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      backgroundColor: "rgba(0,0,0,0.8)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "1rem",
    }}>
      <div style={{
        width: "95vw", maxWidth: "1200px", height: "90vh",
        backgroundColor: "var(--card)",
        borderRadius: "1rem",
        border: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: "1rem",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          <FileCode className="w-5 h-5" style={{ color: "var(--accent)" }} />
          <span style={{ color: "var(--text-primary)", fontFamily: "monospace", fontSize: "0.9rem", flex: 1 }}>
            {fileName}
          </span>

          {/* View mode toggle */}
          <div style={{ display: "flex", gap: "0.25rem" }}>
            <button
              onClick={() => setViewMode("edit")}
              style={{
                padding: "0.375rem 0.75rem", borderRadius: "0.375rem", fontSize: "0.75rem",
                backgroundColor: viewMode === "edit" ? "var(--accent)" : "var(--card-elevated)",
                color: viewMode === "edit" ? "#000" : "var(--text-secondary)",
                border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem",
              }}
            >
              <Code2 className="w-3.5 h-3.5" /> Edit
            </button>
            <button
              onClick={() => setViewMode("preview")}
              style={{
                padding: "0.375rem 0.75rem", borderRadius: "0.375rem", fontSize: "0.75rem",
                backgroundColor: viewMode === "preview" ? "var(--accent)" : "var(--card-elevated)",
                color: viewMode === "preview" ? "#000" : "var(--text-secondary)",
                border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem",
              }}
            >
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: "flex", alignItems: "center", gap: "0.5rem",
              padding: "0.5rem 1rem", borderRadius: "0.5rem",
              backgroundColor: saved ? "var(--success)" : "var(--accent)",
              color: "#000", border: "none", cursor: saving ? "not-allowed" : "pointer",
              fontWeight: 600, fontSize: "0.875rem", opacity: saving ? 0.7 : 1,
            }}
          >
            <Save className="w-4 h-4" />
            {saved ? "Saved!" : saving ? "Saving..." : "Save"}
          </button>

          <button
            onClick={onClose}
            style={{ padding: "0.5rem", borderRadius: "0.5rem", border: "none", cursor: "pointer", backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error bar */}
        {error && (
          <div style={{ padding: "0.5rem 1rem", backgroundColor: "rgba(239,68,68,0.1)", color: "var(--error)", fontSize: "0.875rem" }}>
            {error}
          </div>
        )}

        {/* Editor */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
            </div>
          ) : viewMode === "edit" ? (
            <MonacoEditor
              value={content}
              onChange={(val) => setContent(val || "")}
              language={getMonacoLanguage(fileName)}
              theme="vs-dark"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                renderWhitespace: "selection",
                tabSize: 2,
                automaticLayout: true,
              }}
            />
          ) : (
            <div style={{ height: "100%", overflow: "auto", padding: "1.5rem" }}>
              <pre style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.875rem" }}>
                {content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main FileBrowser Component ────────────────────────────────────────────────
export function FileBrowser({ workspace, path, onNavigate, viewMode = "list" }: FileBrowserProps) {
  const [items, setItems] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ workspace: string; path: string; name: string } | null>(null);
  const [editorFile, setEditorFile] = useState<{ workspace: string; path: string; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [showNewFile, setShowNewFile] = useState(false);
  const [actionMenu, setActionMenu] = useState<string | null>(null);

  // Multi-select + search + clipboard
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [clipboard, setClipboard] = useState<{ action: "copy" | "cut"; items: { name: string; type: string }[] } | null>(null);
  const [renamingItem, setRenamingItem] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const lastClickedIndex = useRef<number>(-1);

  const loadItems = useCallback(() => {
    setLoading(true);
    setError(null);
    setSelectedItems(new Set());
    fetch(`/api/browse?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load directory");
        return res.json();
      })
      .then((data) => {
        setItems(data.items || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [workspace, path]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, searchQuery]);

  const handleItemClick = (item: FileEntry, index: number, e: React.MouseEvent) => {
    // Multi-select with Ctrl/Cmd or Shift
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedItems((prev) => {
        const next = new Set(prev);
        if (next.has(item.name)) next.delete(item.name);
        else next.add(item.name);
        return next;
      });
      lastClickedIndex.current = index;
      return;
    }

    if (e.shiftKey && lastClickedIndex.current >= 0) {
      e.preventDefault();
      const start = Math.min(lastClickedIndex.current, index);
      const end = Math.max(lastClickedIndex.current, index);
      const rangeNames = filteredItems.slice(start, end + 1).map((i) => i.name);
      setSelectedItems((prev) => {
        const next = new Set(prev);
        rangeNames.forEach((n) => next.add(n));
        return next;
      });
      return;
    }

    lastClickedIndex.current = index;
    setSelectedItems(new Set([item.name]));

    if (item.type === "folder") {
      const newPath = path ? `${path}/${item.name}` : item.name;
      onNavigate(newPath);
    } else {
      const filePath = path ? `${path}/${item.name}` : item.name;
      if (isEditable(item.name)) {
        setEditorFile({ workspace, path: filePath, name: item.name });
      } else {
        setPreviewFile({ workspace, path: filePath, name: item.name });
      }
    }
  };

  // Upload handler with progress simulation
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const total = files.length;
      for (let i = 0; i < total; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append("workspace", workspace);
        formData.append("path", path);
        formData.append("files", file);
        await fetch("/api/files/upload", { method: "POST", body: formData });
        setUploadProgress(Math.round(((i + 1) / total) * 100));
      }
      loadItems();
    } catch (e) {
      console.error("Upload error:", e);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDownload = (item: FileEntry) => {
    const filePath = path ? `${path}/${item.name}` : item.name;
    const url = `/api/files/download?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = item.name;
    a.click();
  };

  const handleDelete = async (item: FileEntry) => {
    const filePath = path ? `${path}/${item.name}` : item.name;
    try {
      const res = await fetch("/api/files/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path: filePath }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Delete failed");
      } else {
        loadItems();
      }
    } catch {
      alert("Delete failed");
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedItems.size === 0) return;
    if (!confirm(`Delete ${selectedItems.size} selected item(s)?`)) return;
    let failed = 0;
    for (const name of selectedItems) {
      const filePath = path ? `${path}/${name}` : name;
      try {
        const res = await fetch("/api/files/delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace, path: filePath }),
        });
        if (!res.ok) failed++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) alert(`${failed} item(s) failed to delete`);
    setSelectedItems(new Set());
    loadItems();
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await fetch("/api/files/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path, name: newFolderName.trim() }),
      });
      setNewFolderName("");
      setShowNewFolder(false);
      loadItems();
    } catch {
      alert("Failed to create folder");
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    const filePath = path ? `${path}/${newFileName.trim()}` : newFileName.trim();
    try {
      await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path: filePath, content: "" }),
      });
      setNewFileName("");
      setShowNewFile(false);
      loadItems();
      setEditorFile({ workspace, path: filePath, name: newFileName.trim() });
    } catch {
      alert("Failed to create file");
    }
  };

  const handleRename = async (oldName: string, newName: string) => {
    if (!newName.trim() || newName.trim() === oldName) {
      setRenamingItem(null);
      return;
    }
    const filePath = path ? `${path}/${oldName}` : oldName;
    try {
      const res = await fetch("/api/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path: filePath, newName: newName.trim() }),
      });
      if (!res.ok) throw new Error("Rename failed");
      setRenamingItem(null);
      loadItems();
    } catch {
      alert("Rename failed");
      setRenamingItem(null);
    }
  };

  const handleCopy = () => {
    if (selectedItems.size === 0) return;
    const sel = items.filter((i) => selectedItems.has(i.name)).map((i) => ({ name: i.name, type: i.type }));
    setClipboard({ action: "copy", items: sel });
  };

  const handleCut = () => {
    if (selectedItems.size === 0) return;
    const sel = items.filter((i) => selectedItems.has(i.name)).map((i) => ({ name: i.name, type: i.type }));
    setClipboard({ action: "cut", items: sel });
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    for (const item of clipboard.items) {
      const srcPath = path ? `${path}/${item.name}` : item.name;
      try {
        if (clipboard.action === "copy") {
          // Read then write to destination
          const readRes = await fetch(`/api/browse?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(srcPath)}&content=true`);
          if (!readRes.ok) continue;
          const data = await readRes.json();
          const destName = item.name;
          const destPath = path ? `${path}/${destName}` : destName;
          await fetch("/api/files/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace, path: destPath, content: data.content || "" }),
          });
        } else {
          // Cut = move
          await fetch("/api/files/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace, path: srcPath, destination: path || "" }),
          });
        }
      } catch {
        // skip failed items
      }
    }
    if (clipboard.action === "cut") setClipboard(null);
    setSelectedItems(new Set());
    loadItems();
  };

  // Drag and drop
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editorFile || previewFile || confirmDelete) return; // Don't intercept when modal is open
      if (renamingItem) {
        if (e.key === "Enter") {
          handleRename(renamingItem, renameValue);
        } else if (e.key === "Escape") {
          setRenamingItem(null);
        }
        return;
      }

      if (e.key === "Delete" && selectedItems.size > 0) {
        e.preventDefault();
        if (selectedItems.size === 1) {
          const name = Array.from(selectedItems)[0];
          const item = items.find((i) => i.name === name);
          if (item) setConfirmDelete(item);
        } else {
          handleDeleteSelected();
        }
      }
      if (e.key === "F2" && selectedItems.size === 1) {
        e.preventDefault();
        const name = Array.from(selectedItems)[0];
        setRenamingItem(name);
        setRenameValue(name);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedItems.size > 0) {
        e.preventDefault();
        handleCopy();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selectedItems.size > 0) {
        e.preventDefault();
        handleCut();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
        e.preventDefault();
        handlePaste();
      }
      if (e.key === "Escape") {
        setSelectedItems(new Set());
        setClipboard(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedItems, items, clipboard, renamingItem, renameValue, editorFile, previewFile, confirmDelete, path, workspace]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12" style={{ color: "var(--accent)" }}>
        <AlertCircle className="w-12 h-12 mb-4" />
        <p>{error}</p>
      </div>
    );
  }

  const isSelected = (name: string) => selectedItems.has(name);

  return (
    <>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: "0.5rem",
        padding: "0.5rem 1rem",
        borderBottom: "1px solid var(--border)",
        flexWrap: "wrap",
      }}>
        {/* Upload */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Upload files"
          style={{
            display: "flex", alignItems: "center", gap: "0.375rem",
            padding: "0.375rem 0.75rem", borderRadius: "0.5rem",
            backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)",
            border: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem",
          }}
        >
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleUpload(e.target.files)}
        />

        {/* Upload Folder */}
        <button
          onClick={() => folderInputRef.current?.click()}
          disabled={uploading}
          title="Upload folder"
          style={{
            display: "flex", alignItems: "center", gap: "0.375rem",
            padding: "0.375rem 0.75rem", borderRadius: "0.5rem",
            backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)",
            border: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem",
          }}
        >
          <FolderPlus className="w-3.5 h-3.5" /> Folder
        </button>
        <input
          ref={folderInputRef}
          type="file"
          {...{ webkitdirectory: "", directory: "" } as any}
          style={{ display: "none" }}
          onChange={(e) => handleUpload(e.target.files)}
        />

        {/* New Folder */}
        <button
          onClick={() => setShowNewFolder(true)}
          title="New folder"
          style={{
            display: "flex", alignItems: "center", gap: "0.375rem",
            padding: "0.375rem 0.75rem", borderRadius: "0.5rem",
            backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)",
            border: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem",
          }}
        >
          <FolderPlus className="w-3.5 h-3.5" /> New Folder
        </button>

        {/* New File */}
        <button
          onClick={() => setShowNewFile(true)}
          title="New file"
          style={{
            display: "flex", alignItems: "center", gap: "0.375rem",
            padding: "0.375rem 0.75rem", borderRadius: "0.5rem",
            backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)",
            border: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem",
          }}
        >
          <FilePlus className="w-3.5 h-3.5" /> New File
        </button>

        {/* Search */}
        <div style={{ position: "relative", marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <Search className="w-3.5 h-3.5" style={{ position: "absolute", left: "0.5rem", color: "var(--text-muted)" }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            style={{
              padding: "0.375rem 0.5rem 0.375rem 1.75rem", borderRadius: "0.5rem",
              backgroundColor: "var(--card-elevated)", color: "var(--text-primary)",
              border: "1px solid var(--border)", fontSize: "0.8rem", outline: "none",
              width: "160px",
            }}
          />
        </div>

        {/* Selection actions */}
        {selectedItems.size > 0 && (
          <>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
              {selectedItems.size} selected
            </span>
            <button onClick={handleCopy} title="Copy (Ctrl+C)" style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
              <ClipboardPaste className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleCut} title="Cut (Ctrl+X)" style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
              <Scissors className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleDeleteSelected} title="Delete" style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {clipboard && (
          <button onClick={handlePaste} title={`Paste ${clipboard.items.length} item(s) (Ctrl+V)`} style={{
            display: "flex", alignItems: "center", gap: "0.25rem",
            padding: "0.25rem 0.5rem", borderRadius: "0.25rem",
            background: "var(--accent-soft)", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.75rem",
          }}>
            <ClipboardPaste className="w-3.5 h-3.5" /> Paste {clipboard.items.length}
          </button>
        )}

        <button
          onClick={loadItems}
          title="Refresh"
          style={{
            display: "flex", alignItems: "center",
            padding: "0.375rem", borderRadius: "0.5rem",
            backgroundColor: "transparent", color: "var(--text-muted)",
            border: "none", cursor: "pointer", marginLeft: "auto",
          }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Upload progress */}
      {uploading && (
        <div style={{ padding: "0.5rem 1rem", borderBottom: "1px solid var(--border)", backgroundColor: "var(--card-elevated)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Uploading... {uploadProgress}%
          </div>
          <div style={{ width: "100%", height: "4px", backgroundColor: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
            <div style={{ width: `${uploadProgress}%`, height: "100%", backgroundColor: "var(--accent)", transition: "width 0.2s" }} />
          </div>
        </div>
      )}

      {/* New Folder input */}
      {showNewFolder && (
        <div style={{ display: "flex", gap: "0.5rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", backgroundColor: "var(--card-elevated)" }}>
          <Folder className="w-4 h-4 mt-1.5" style={{ color: "#F59E0B", flexShrink: 0 }} />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
            placeholder="Folder name..."
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: "0.9rem" }}
          />
          <button onClick={handleCreateFolder} style={{ padding: "0.25rem 0.75rem", borderRadius: "0.375rem", background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontSize: "0.8rem" }}>Create</button>
          <button onClick={() => setShowNewFolder(false)} style={{ padding: "0.25rem", borderRadius: "0.375rem", background: "none", color: "var(--text-muted)", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* New File input */}
      {showNewFile && (
        <div style={{ display: "flex", gap: "0.5rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", backgroundColor: "var(--card-elevated)" }}>
          <File className="w-4 h-4 mt-1.5" style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
          <input
            autoFocus
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateFile(); if (e.key === "Escape") setShowNewFile(false); }}
            placeholder="filename.ts"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: "0.9rem" }}
          />
          <button onClick={handleCreateFile} style={{ padding: "0.25rem 0.75rem", borderRadius: "0.375rem", background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontSize: "0.8rem" }}>Create</button>
          <button onClick={() => setShowNewFile(false)} style={{ padding: "0.25rem", borderRadius: "0.375rem", background: "none", color: "var(--text-muted)", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          flex: 1,
          outline: dragging ? "2px dashed var(--accent)" : "none",
          outlineOffset: "-2px",
          transition: "outline 0.2s",
          minHeight: "100px",
        }}
      >
        {filteredItems.length === 0 && !dragging && (
          <div className="flex flex-col items-center justify-center py-12" style={{ color: "var(--text-secondary)" }}>
            <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
            <p>{searchQuery ? "No files match your search" : "This folder is empty"}</p>
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>Drag & drop files to upload</p>
          </div>
        )}

        {dragging && (
          <div className="flex flex-col items-center justify-center py-12" style={{ color: "var(--accent)" }}>
            <Upload className="w-16 h-16 mb-4" />
            <p>Drop files to upload</p>
          </div>
        )}

        {/* List View */}
        {viewMode === "list" && filteredItems.length > 0 && !dragging && (
          <div className="rounded-xl overflow-hidden" style={{ backgroundColor: "var(--card)" }}>
            <div
              className="hidden md:grid grid-cols-12 gap-4 px-4 md:px-6 py-2 md:py-3 text-xs md:text-sm font-medium"
              style={{ backgroundColor: "var(--background)", color: "var(--text-secondary)" }}
            >
              <div className="col-span-6">Name</div>
              <div className="col-span-2">Size</div>
              <div className="col-span-3">Modified</div>
              <div className="col-span-1"></div>
            </div>

            {filteredItems.map((item, index) => {
              const Icon = getFileIcon(item.name, item.type);
              const iconColor = getFileColor(item.name, item.type);
              const filePath = path ? `${path}/${item.name}` : item.name;
              const selected = isSelected(item.name);

              return (
                <div
                  key={item.name}
                  className="flex md:grid md:grid-cols-12 gap-2 md:gap-4 px-3 md:px-6 py-2.5 md:py-3 cursor-pointer transition-colors hover:opacity-80 group"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    position: "relative",
                    backgroundColor: selected ? "var(--accent-soft, rgba(59,130,246,0.1))" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.backgroundColor = "var(--background)"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.backgroundColor = "transparent"; setActionMenu(null); }}
                >
                  {/* Name */}
                  <div
                    className="md:col-span-6 flex items-center gap-2 md:gap-3 min-w-0 flex-1"
                    onClick={(e) => handleItemClick(item, index, e)}
                  >
                    <Icon className="w-4 h-4 md:w-5 md:h-5 shrink-0" style={{ color: iconColor }} />
                    {renamingItem === item.name ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRename(item.name, renameValue); if (e.key === "Escape") setRenamingItem(null); }}
                        onBlur={() => handleRename(item.name, renameValue)}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          background: "var(--card-elevated)", border: "1px solid var(--accent)", borderRadius: "0.25rem",
                          color: "var(--text-primary)", fontSize: "0.875rem", padding: "0.125rem 0.5rem", outline: "none", flex: 1,
                        }}
                      />
                    ) : (
                      <span className="truncate text-sm md:text-base" style={{ color: "var(--text-primary)" }}>
                        {item.name}
                      </span>
                    )}
                    {isEditable(item.name) && item.type === "file" && (
                      <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", opacity: 0 }} className="group-hover:opacity-100">
                        edit
                      </span>
                    )}
                  </div>

                  {/* Size */}
                  <div className="md:col-span-2 text-xs md:text-sm flex items-center" style={{ color: "var(--text-secondary)" }}
                    onClick={(e) => handleItemClick(item, index, e)}
                  >
                    {item.type === "folder" ? "—" : formatFileSize(item.size)}
                  </div>

                  {/* Modified */}
                  <div
                    className="hidden md:col-span-3 md:text-sm md:flex items-center"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={(e) => handleItemClick(item, index, e)}
                  >
                    {format(new Date(item.modified), "MMM d, yyyy HH:mm")}
                  </div>

                  {/* Actions */}
                  <div className="md:col-span-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingItem(item.name); setRenameValue(item.name); }}
                      title="Rename (F2)"
                      style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {item.type === "file" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(item); }}
                        title="Download"
                        style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(item); }}
                      title="Delete"
                      style={{ padding: "0.25rem", borderRadius: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Grid View */}
        {viewMode === "grid" && filteredItems.length > 0 && !dragging && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 md:gap-4 p-4">
            {filteredItems.map((item, index) => {
              const Icon = getFileIcon(item.name, item.type);
              const iconColor = getFileColor(item.name, item.type);
              const selected = isSelected(item.name);

              return (
                <div
                  key={item.name}
                  onClick={(e) => handleItemClick(item, index, e)}
                  className="flex flex-col items-center p-3 md:p-4 rounded-xl cursor-pointer transition-all group relative"
                  style={{
                    backgroundColor: selected ? "var(--accent-soft, rgba(59,130,246,0.15))" : "var(--card)",
                    outline: selected ? "2px solid var(--accent)" : "none",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.backgroundColor = "var(--background)"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.backgroundColor = "var(--card)"; }}
                >
                  <Icon className="w-10 h-10 md:w-12 md:h-12 mb-2 md:mb-3 group-hover:scale-110 transition-transform" style={{ color: iconColor }} />
                  {renamingItem === item.name ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleRename(item.name, renameValue); if (e.key === "Escape") setRenamingItem(null); }}
                      onBlur={() => handleRename(item.name, renameValue)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        background: "var(--card-elevated)", border: "1px solid var(--accent)", borderRadius: "0.25rem",
                        color: "var(--text-primary)", fontSize: "0.75rem", padding: "0.125rem 0.25rem", outline: "none", width: "100%", textAlign: "center",
                      }}
                    />
                  ) : (
                    <span className="text-xs md:text-sm text-center truncate w-full" style={{ color: "var(--text-primary)" }} title={item.name}>
                      {item.name}
                    </span>
                  )}
                  <span className="text-[10px] md:text-xs mt-0.5 md:mt-1" style={{ color: "var(--text-muted)" }}>
                    {item.type === "folder" ? "Folder" : formatFileSize(item.size)}
                  </span>

                  {/* Quick action buttons on hover */}
                  <div style={{
                    position: "absolute", top: "0.25rem", right: "0.25rem",
                    display: "flex", gap: "0.125rem",
                    opacity: 0,
                  }} className="group-hover:!opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingItem(item.name); setRenameValue(item.name); }}
                      style={{ padding: "0.2rem", borderRadius: "0.25rem", background: "var(--card-elevated)", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {item.type === "file" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(item); }}
                        style={{ padding: "0.2rem", borderRadius: "0.25rem", background: "var(--card-elevated)", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                      >
                        <Download className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(item); }}
                      style={{ padding: "0.2rem", borderRadius: "0.25rem", background: "var(--card-elevated)", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          backgroundColor: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            backgroundColor: "var(--card)", borderRadius: "1rem",
            padding: "2rem", maxWidth: "400px", width: "90%",
            border: "1px solid var(--border)",
          }}>
            <h3 style={{ color: "var(--text-primary)", marginBottom: "0.75rem", fontSize: "1.1rem", fontWeight: 600 }}>
              Delete {confirmDelete.type === "folder" ? "Folder" : "File"}?
            </h3>
            <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
              Are you sure you want to delete <strong style={{ color: "var(--text-primary)" }}>{confirmDelete.name}</strong>?
              {confirmDelete.type === "folder" && " This will delete all contents inside."}
              This action cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", background: "var(--card-elevated)", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", background: "var(--error, #ef4444)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreview
          workspace={previewFile.workspace}
          path={previewFile.path}
          name={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* Monaco Editor Modal */}
      {editorFile && (
        <EditorModal
          workspace={editorFile.workspace}
          filePath={editorFile.path}
          fileName={editorFile.name}
          onClose={() => { setEditorFile(null); loadItems(); }}
        />
      )}
    </>
  );
}
