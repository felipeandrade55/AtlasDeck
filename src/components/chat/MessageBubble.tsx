"use client";

import { useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, ChevronDown, ChevronRight, Copy, User, Volume2, Wrench } from "lucide-react";
import type { ChatMessage, AgentSummary } from "./types";

interface MessageBubbleProps {
  message: ChatMessage;
  agent?: AgentSummary;
  onSpeak?: (text: string) => void;
  isSpeaking?: boolean;
}

export function MessageBubble({ message, agent, onSpeak, isSpeaking }: MessageBubbleProps) {
  const [collapsed, setCollapsed] = useState(message.role === "tool_use" || message.role === "tool_result");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = message.content ?? "";
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback para contextos não-seguros (http) onde a Clipboard API não existe.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // silencioso: copiar é best-effort
    }
  };

  if (message.role === "tool_use" || message.role === "tool_result") {
    return (
      <div style={toolWrapStyle}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          style={toolHeaderStyle}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Wrench size={14} />
          <span style={{ fontWeight: 600 }}>
            {message.role === "tool_use" ? "Tool call" : "Tool result"}
          </span>
          {message.tool_name && (
            <code style={{ color: "var(--accent)" }}>{message.tool_name}</code>
          )}
        </button>
        {!collapsed && (
          <pre style={toolBodyStyle}>
            {message.role === "tool_use"
              ? JSON.stringify(message.tool_input, null, 2)
              : message.tool_output ?? message.content}
          </pre>
        )}
      </div>
    );
  }

  const isUser = message.role === "user";
  const isError = message.status === "error";
  const isStreaming = message.status === "streaming";

  return (
    <div style={rowStyle(isUser)}>
      {!isUser && (
        <div style={avatarStyle(agent?.color ?? "#3b82f6")}>
          {agent?.emoji ?? <Bot size={18} />}
        </div>
      )}
      <div style={{ maxWidth: "min(720px, 80%)" }}>
        <div style={metaRowStyle(isUser)}>
          <span style={{ fontWeight: 600 }}>
            {isUser ? "Você" : agent?.name ?? message.role}
          </span>
          <span style={{ color: "var(--text-muted)" }}>
            {new Date(message.created_at).toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {!isUser && onSpeak && message.content && !isStreaming && (
            <button
              type="button"
              onClick={() => onSpeak(message.content)}
              style={ttsButtonStyle(isSpeaking)}
              title={isSpeaking ? "Falando…" : "Ouvir resposta"}
            >
              <Volume2 size={14} />
            </button>
          )}
          {!isUser && message.content && !isStreaming && (
            <button
              type="button"
              onClick={handleCopy}
              style={ttsButtonStyle(copied)}
              title={copied ? "Copiado!" : "Copiar resposta"}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
        </div>
        <div style={bubbleStyle({ isUser, isError, isStreaming, isStub: !!message.stubReply })}>
          {!isUser && message.stubReply && (
            <div style={stubBadgeStyle}>
              ⚠ <strong>Stub de notificação</strong> — esta bolha não é a resposta real.
              O agente roteou o conteúdo para outro canal (ex.: Telegram). Use{" "}
              <em>Forçar resposta direta</em> no banner acima para reenviar.
            </div>
          )}
          {isUser ? (
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.content}</p>
          ) : (
            <div className="prose prose-invert max-w-none" style={{ fontSize: 14 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content || (isStreaming ? "▋" : "")}
              </ReactMarkdown>
            </div>
          )}
          {isError && message.error && (
            <p style={errorTextStyle}>⚠ {message.error}</p>
          )}
          {isStreaming && (
            <span style={cursorStyle} aria-hidden>
              ▋
            </span>
          )}
        </div>
        {(message.tokens_in > 0 ||
          message.tokens_out > 0 ||
          message.provider ||
          message.firstTokenMs ||
          message.totalMs) && (
          <div style={usageStyle(isUser)}>
            {message.provider && (
              <span
                style={providerBadgeStyle(message.provider)}
                title={message.providerDetail ?? undefined}
              >
                {providerLabel(message.provider)}
                {message.providerDetail && ` · ${message.providerDetail.slice(0, 240)}`}
              </span>
            )}
            {message.firstTokenMs != null && (
              <span style={{ marginLeft: 6 }}>
                ⏱ {formatMs(message.firstTokenMs)} → 1º token
              </span>
            )}
            {message.totalMs != null && (
              <span style={{ marginLeft: 6 }}>· total {formatMs(message.totalMs)}</span>
            )}
            {(message.tokens_in > 0 || message.tokens_out > 0) && (
              <span style={{ marginLeft: 6 }}>
                · ↑ {message.tokens_in} · ↓ {message.tokens_out}
                {message.cost > 0 && ` · $${message.cost.toFixed(4)}`}
              </span>
            )}
          </div>
        )}
      </div>
      {isUser && (
        <div style={avatarStyle("var(--accent)")}>
          <User size={18} />
        </div>
      )}
    </div>
  );
}

function rowStyle(isUser: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: isUser ? "row-reverse" : "row",
    gap: 12,
    alignItems: "flex-start",
    width: "100%",
  };
}

function avatarStyle(color: string): CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: color,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
    flexShrink: 0,
  };
}

function metaRowStyle(isUser: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: isUser ? "row-reverse" : "row",
    gap: 8,
    fontSize: 12,
    color: "var(--text-secondary)",
    marginBottom: 4,
    alignItems: "center",
  };
}

function bubbleStyle({
  isUser,
  isError,
  isStreaming,
  isStub,
}: {
  isUser: boolean;
  isError: boolean;
  isStreaming: boolean;
  isStub: boolean;
}): CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    background: isUser
      ? "var(--accent-soft)"
      : isError
      ? "var(--danger-soft, rgba(239,68,68,0.15))"
      : isStub
      ? "rgba(234,179,8,0.08)"
      : "var(--surface)",
    border: `1px solid ${
      isError
        ? "var(--danger, #ef4444)"
        : isStub
        ? "rgba(234,179,8,0.45)"
        : "var(--border)"
    }`,
    color: "var(--text-primary)",
    fontSize: 14,
    lineHeight: 1.55,
    boxShadow: isStreaming ? "0 0 0 1px var(--accent)" : undefined,
    position: "relative",
  };
}

const stubBadgeStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  padding: "6px 8px",
  borderRadius: 6,
  background: "rgba(234,179,8,0.14)",
  border: "1px solid rgba(234,179,8,0.5)",
  color: "#facc15",
  fontSize: 11,
  lineHeight: 1.4,
};

const toolWrapStyle: CSSProperties = {
  margin: "4px auto",
  width: "min(720px, 90%)",
  borderRadius: 8,
  border: "1px dashed var(--border)",
  background: "var(--surface)",
  fontSize: 12,
};

const toolHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontFamily: "var(--font-body)",
  fontSize: 12,
};

const toolBodyStyle: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  borderTop: "1px dashed var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 240,
  overflow: "auto",
};

function ttsButtonStyle(active?: boolean): CSSProperties {
  return {
    width: 22,
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    border: "none",
    cursor: "pointer",
  };
}

const errorTextStyle: CSSProperties = {
  margin: "8px 0 0 0",
  fontSize: 12,
  color: "var(--danger, #ef4444)",
};

const cursorStyle: CSSProperties = {
  display: "inline-block",
  marginLeft: 2,
  animation: "blink 1s steps(1) infinite",
  color: "var(--accent)",
};

function usageStyle(isUser: boolean): CSSProperties {
  return {
    fontSize: 10,
    color: "var(--text-muted)",
    marginTop: 4,
    textAlign: isUser ? "right" : "left",
    display: "flex",
    gap: 0,
    flexWrap: "wrap",
    alignItems: "center",
  };
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "ws":
      return "⚡ WS";
    case "cli":
      return "🐢 CLI";
    case "ollama":
      return "🦙 Ollama";
    case "atlas":
      return "⚡ Atlas";
    default:
      return provider;
  }
}

function providerBadgeStyle(provider: string): CSSProperties {
  const color =
    provider === "ws"
      ? "#22c55e"
      : provider === "atlas"
      ? "#14b8a6"
      : provider === "cli"
      ? "#f59e0b"
      : provider === "ollama"
      ? "#6366f1"
      : "var(--text-muted)";
  return {
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: 4,
    border: `1px solid ${color}`,
    color,
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: 0.4,
    maxWidth: "100%",
    whiteSpace: "normal",
    wordBreak: "break-word",
    lineHeight: 1.3,
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
