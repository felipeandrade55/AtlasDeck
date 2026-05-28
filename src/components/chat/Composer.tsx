"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Send, Square, Paperclip, X, FileText, Loader2 } from "lucide-react";
import { MicButton } from "./MicButton";

interface ComposerProps {
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  placeholder?: string;
  voiceLang?: string;
}

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "success" | "error";
  content?: string;
  error?: string;
}

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const INLINE_SIZE_LIMIT_BYTES = 2 * 1024 * 1024; // Inline text up to 2MB

export function Composer({
  disabled,
  isStreaming,
  onSend,
  onStop,
  placeholder = "Pergunte algo ao Jarvis... (Shift+Enter para nova linha)",
  voiceLang,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    autosize(textareaRef.current);
  }, [text]);

  const submit = useCallback(() => {
    let trimmed = text.trim();
    const hasAttachments = attachedFiles.length > 0;
    const isUploading = attachedFiles.some((f) => f.status === "uploading");

    if ((!trimmed && !hasAttachments) || disabled || isStreaming || isUploading) return;

    if (hasAttachments) {
      const parts: string[] = [];
      if (trimmed) parts.push(trimmed);

      const inlinedFiles = attachedFiles.filter((f) => f.status === "success" && f.content);
      const workspaceFiles = attachedFiles.filter((f) => f.status === "success" && !f.content);

      if (inlinedFiles.length > 0) {
        parts.push("\n\n--- 📥 CONTEÚDO DOS ARQUIVOS ANEXADOS ---");
        for (const file of inlinedFiles) {
          parts.push(
            `\n=== Arquivo: ${file.name} (${formatBytes(file.size)}) ===\n${
              file.content
            }\n===========================================`
          );
        }
      }

      if (workspaceFiles.length > 0) {
        parts.push("\n\n--- 📂 ARQUIVOS SALVOS NO WORKSPACE ---");
        for (const file of workspaceFiles) {
          parts.push(
            `- Nome: ${file.name} (${formatBytes(
              file.size
            )})\n  Caminho no Workspace: uploads/${
              file.name
            }\n  [Use suas ferramentas de leitura se precisar analisar este arquivo.]`
          );
        }
      }

      trimmed = parts.join("\n");
    }

    onSend(trimmed);
    setText("");
    setInterim("");
    setAttachedFiles([]);
  }, [text, attachedFiles, disabled, isStreaming, onSend]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = Math.random().toString(36).substring(7);

      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`O arquivo "${file.name}" excede o limite de ${MAX_FILE_SIZE_MB}MB.`);
        continue;
      }

      const newAttachedFile: AttachedFile = {
        id,
        name: file.name,
        size: file.size,
        status: "uploading",
      };

      setAttachedFiles((prev) => [...prev, newAttachedFile]);

      // Process upload in background
      uploadAndReadFile(file, id);
    }

    // Reset input value so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const uploadAndReadFile = async (file: File, id: string) => {
    try {
      // 1. Upload file to workspace uploads path
      const formData = new FormData();
      formData.append("workspace", "workspace");
      formData.append("path", "uploads");
      formData.append("files", file);

      const uploadPromise = fetch("/api/files/upload", {
        method: "POST",
        body: formData,
      });

      // 2. Read text content locally if light and text-based
      let content: string | undefined = undefined;
      if (isTextBasedFile(file) && file.size <= INLINE_SIZE_LIMIT_BYTES) {
        content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve((e.target?.result as string) || "");
          reader.onerror = (err) => reject(err);
          reader.readAsText(file);
        });
      }

      const res = await uploadPromise;
      if (!res.ok) throw new Error("Upload failed");

      setAttachedFiles((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, status: "success", content } : f
        )
      );
    } catch (err: any) {
      console.error("[composer] file process error", err);
      setAttachedFiles((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, status: "error", error: err.message || "Falhou" } : f
        )
      );
    }
  };

  const removeFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const isUploading = attachedFiles.some((f) => f.status === "uploading");

  return (
    <div style={wrapStyle}>
      {/* Attached Files View */}
      {attachedFiles.length > 0 && (
        <div style={attachmentsContainerStyle}>
          {attachedFiles.map((file) => (
            <div
              key={file.id}
              style={filePillStyle(file.status)}
              title={
                file.status === "error"
                  ? `Erro: ${file.error}`
                  : `${file.name} (${formatBytes(file.size)})`
              }
            >
              {file.status === "uploading" ? (
                <Loader2 size={14} className="animate-spin" style={{ color: "var(--accent)" }} />
              ) : (
                <FileText size={14} style={{ color: file.status === "error" ? "var(--danger)" : "var(--accent)" }} />
              )}
              <span style={fileNameStyle}>{file.name}</span>
              <span style={fileSizeStyle}>({formatBytes(file.size)})</span>
              <button
                type="button"
                onClick={() => removeFile(file.id)}
                style={removePillButtonStyle}
                title="Remover anexo"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {interim && (
        <div style={interimStyle}>
          <span style={{ color: "var(--text-muted)" }}>🎙 </span>
          {interim}
        </div>
      )}
      <div style={rowStyle}>
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          multiple
          style={{ display: "none" }}
        />

        {/* Paperclip Attachment Button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isStreaming}
          style={attachmentButtonStyle}
          title="Anexar arquivos (até 50MB)"
        >
          <Paperclip size={18} />
        </button>

        <MicButton
          lang={voiceLang}
          disabled={disabled || isStreaming}
          onInterim={setInterim}
          onFinal={(finalText) => {
            setInterim("");
            const merged = (text ? `${text} ${finalText}` : finalText).trim();
            setText(merged);
            // Auto-send if message looks ready
            if (merged.length > 0) {
              onSend(merged);
              setText("");
            }
          }}
        />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          style={textareaStyle}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            style={stopButtonStyle}
            title="Parar geração"
          >
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={(!text.trim() && attachedFiles.length === 0) || disabled || isUploading}
            style={sendButtonStyle((!text.trim() && attachedFiles.length === 0) || disabled || isUploading)}
            title="Enviar"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

function isTextBasedFile(file: File): boolean {
  const textExtensions = [
    ".txt",
    ".csv",
    ".log",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".md",
    ".html",
    ".css",
    ".sh",
    ".bat",
    ".ini",
    ".conf",
    ".cfg",
  ];
  const name = file.name.toLowerCase();
  const isExt = textExtensions.some((ext) => name.endsWith(ext));
  const isMime =
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/javascript";
  return isExt || isMime;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

const wrapStyle: CSSProperties = {
  padding: 12,
  borderTop: "1px solid var(--border)",
  background: "var(--bg)",
};

const interimStyle: CSSProperties = {
  padding: "6px 12px",
  marginBottom: 6,
  borderRadius: 6,
  background: "var(--surface)",
  border: "1px dashed var(--border)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontStyle: "italic",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
};

const textareaStyle: CSSProperties = {
  flex: 1,
  resize: "none",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 14px",
  color: "var(--text-primary)",
  fontFamily: "var(--font-body)",
  fontSize: 14,
  lineHeight: 1.5,
  minHeight: 44,
  maxHeight: 200,
  outline: "none",
};

const attachmentsContainerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 10,
  padding: "4px 0",
};

function filePillStyle(status: "uploading" | "success" | "error"): CSSProperties {
  const border =
    status === "error"
      ? "1px solid var(--danger, #ef4444)"
      : "1px solid var(--border)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 8,
    background: "var(--surface)",
    border,
    fontSize: 12,
    color: "var(--text-primary)",
    maxWidth: "260px",
  };
}

const fileNameStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 500,
};

const fileSizeStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  flexShrink: 0,
};

const removePillButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  padding: 2,
  borderRadius: 4,
  marginLeft: 4,
};

const attachmentButtonStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 10,
  background: "var(--surface)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

function sendButtonStyle(disabled?: boolean): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: disabled ? "var(--surface)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "#fff",
    border: "1px solid var(--border)",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

const stopButtonStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 10,
  background: "var(--danger, #ef4444)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
