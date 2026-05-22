"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Send, Square } from "lucide-react";
import { MicButton } from "./MicButton";

interface ComposerProps {
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  placeholder?: string;
  voiceLang?: string;
}

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    autosize(textareaRef.current);
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setText("");
    setInterim("");
  }, [text, disabled, isStreaming, onSend]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div style={wrapStyle}>
      {interim && (
        <div style={interimStyle}>
          <span style={{ color: "var(--text-muted)" }}>🎙 </span>
          {interim}
        </div>
      )}
      <div style={rowStyle}>
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
            disabled={!text.trim() || disabled}
            style={sendButtonStyle(!text.trim() || disabled)}
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
};
