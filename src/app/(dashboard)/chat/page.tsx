"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
// handleSend ref forwarded to the wake word hook so the callback can call
// the latest version without forcing it to be declared before the hook.
import { Bot, Download, Settings as SettingsIcon, Volume2, VolumeX } from "lucide-react";
import { ThreadList } from "@/components/chat/ThreadList";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { Composer } from "@/components/chat/Composer";
import { ImportOpenClawModal } from "@/components/chat/ImportOpenClawModal";
import { VoiceSettingsModal } from "@/components/chat/VoiceSettingsModal";
import { WakeIndicator } from "@/components/chat/WakeIndicator";
import { HeardPanel } from "@/components/chat/HeardPanel";
import { useChatStream } from "@/components/chat/useChatStream";
import { useTtsEngine } from "@/components/chat/useTtsEngine";
import { useWakeWord } from "@/components/chat/useWakeWord";

// "Atlas" comes first because it's a real Portuguese word — Web Speech's
// pt-BR engine transcribes it reliably. "Jarvis" is kept as a secondary
// option even though pt-BR ASR mistranscribes it often (jesus, jovis,
// jarves, etc.); the alias map in useWakeWord covers most variants.
const WAKE_PHRASES = ["Atlas", "Jarvis"];
import type {
  AgentSummary,
  ChatMessage,
  ChatThread,
} from "@/components/chat/types";

interface AgentApiResponse {
  agents?: Array<{
    id: string;
    name?: string;
    emoji?: string;
    color?: string;
  }>;
}

export default function ChatPage() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("main");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(true);
  const [wakeTeaser, setWakeTeaser] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const stream = useChatStream();
  const tts = useTtsEngine();
  const handleSendRef = useRef<((text: string) => Promise<void>) | null>(null);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentSummary>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) return;
      const data = (await res.json()) as AgentApiResponse;
      const list = (data.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        emoji: a.emoji ?? "🤖",
        color: a.color ?? "#3b82f6",
      }));
      setAgents(list);
      if (list.length > 0 && !list.find((a) => a.id === selectedAgent)) {
        setSelectedAgent(list[0].id);
      }
    } catch {
      // ignore
    }
  }, [selectedAgent]);

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/threads");
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ChatThread[] };
      setThreads(data.threads ?? []);
    } catch {
      // ignore
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const res = await fetch(`/api/chat/threads/${threadId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        thread: ChatThread;
        messages: ChatMessage[];
      };
      setMessages(data.messages ?? []);
      setThreads((current) => {
        const idx = current.findIndex((t) => t.id === threadId);
        if (idx === -1) return current;
        const next = [...current];
        next[idx] = data.thread;
        return next;
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadAgents();
    loadThreads();
  }, [loadAgents, loadThreads]);

  useEffect(() => {
    if (activeThreadId) loadMessages(activeThreadId);
    else setMessages([]);
  }, [activeThreadId, loadMessages]);

  useEffect(() => {
    if (activeThread) setSelectedAgent(activeThread.agent_id);
  }, [activeThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (activeThreadId) return activeThreadId;
    try {
      const res = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgent }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { thread: ChatThread };
      setThreads((prev) => [data.thread, ...prev]);
      setActiveThreadId(data.thread.id);
      return data.thread.id;
    } catch {
      return null;
    }
  }, [activeThreadId, selectedAgent]);

  const handleCreateThread = useCallback(async () => {
    setActiveThreadId(null);
    setMessages([]);
    setStatusBanner(null);
  }, []);

  const handleSelectThread = useCallback((id: string) => {
    setActiveThreadId(id);
    setStatusBanner(null);
  }, []);

  const handleTogglePin = useCallback(async (thread: ChatThread) => {
    const res = await fetch(`/api/chat/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: !thread.pinned }),
    });
    if (res.ok) {
      const data = (await res.json()) as { thread: ChatThread };
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? data.thread : t)));
    }
  }, []);

  const handleDeleteThread = useCallback(async (thread: ChatThread) => {
    const res = await fetch(`/api/chat/threads/${thread.id}`, { method: "DELETE" });
    if (res.ok) {
      setThreads((prev) => prev.filter((t) => t.id !== thread.id));
      if (activeThreadId === thread.id) {
        setActiveThreadId(null);
        setMessages([]);
      }
    }
  }, [activeThreadId]);

  const speak = useCallback(
    async (text: string, id?: string) => {
      if (!tts.supported || !text) return;
      tts.cancel();
      setSpeakingId(id ?? null);
      try {
        await tts.speak(text);
      } catch {
        // ignore
      } finally {
        setSpeakingId(null);
      }
    },
    [tts],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const threadId = await ensureThread();
      const agentId = selectedAgent;
      const userTempId = `tmp-user-${Date.now()}`;
      const assistantTempId = `tmp-assistant-${Date.now() + 1}`;
      const nowIso = new Date().toISOString();

      // Optimistic insert
      setMessages((prev) => [
        ...prev,
        {
          id: userTempId,
          thread_id: threadId ?? "",
          role: "user",
          content: text,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          audio_path: null,
          tts_path: null,
          tokens_in: 0,
          tokens_out: 0,
          cost: 0,
          status: "complete",
          error: null,
          created_at: nowIso,
        },
        {
          id: assistantTempId,
          thread_id: threadId ?? "",
          role: "assistant",
          content: "",
          tool_name: null,
          tool_input: null,
          tool_output: null,
          audio_path: null,
          tts_path: null,
          tokens_in: 0,
          tokens_out: 0,
          cost: 0,
          status: "streaming",
          error: null,
          created_at: nowIso,
        },
      ]);

      setStatusBanner(null);
      let realAssistantId = assistantTempId;
      let assembled = "";
      const startedAt = Date.now();
      let firstTokenAt: number | null = null;

      await stream.send({
        threadId: threadId ?? undefined,
        agentId,
        message: text,
        onMeta: (meta) => {
          realAssistantId = meta.assistantMessageId;
          if (!activeThreadId) setActiveThreadId(meta.threadId);
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === userTempId) return { ...m, id: meta.userMessageId, thread_id: meta.threadId };
              if (m.id === assistantTempId) return { ...m, id: meta.assistantMessageId, thread_id: meta.threadId };
              return m;
            }),
          );
        },
        onProvider: ({ provider, detail }) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? { ...m, provider, providerDetail: detail }
                : m,
            ),
          );
        },
        onToken: (delta) => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          assembled += delta;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? {
                    ...m,
                    content: assembled,
                    firstTokenMs:
                      m.firstTokenMs ?? (firstTokenAt ? firstTokenAt - startedAt : undefined),
                  }
                : m,
            ),
          );
        },
        onToolUse: ({ id, name, input }) => {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== realAssistantId),
            {
              id: `tool-use-${id ?? Date.now()}`,
              thread_id: threadId ?? "",
              role: "tool_use",
              content: name,
              tool_name: name,
              tool_input: input,
              tool_output: null,
              audio_path: null,
              tts_path: null,
              tokens_in: 0,
              tokens_out: 0,
              cost: 0,
              status: "complete",
              error: null,
              created_at: new Date().toISOString(),
            },
            ...prev.filter((m) => m.id === realAssistantId),
          ]);
        },
        onToolResult: ({ id, output }) => {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== realAssistantId),
            {
              id: `tool-result-${id ?? Date.now()}`,
              thread_id: threadId ?? "",
              role: "tool_result",
              content: output.slice(0, 4000),
              tool_name: null,
              tool_input: null,
              tool_output: output,
              audio_path: null,
              tts_path: null,
              tokens_in: 0,
              tokens_out: 0,
              cost: 0,
              status: "complete",
              error: null,
              created_at: new Date().toISOString(),
            },
            ...prev.filter((m) => m.id === realAssistantId),
          ]);
        },
        onUsage: ({ tokensIn, tokensOut, cost }) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? { ...m, tokens_in: tokensIn, tokens_out: tokensOut, cost: cost ?? m.cost }
                : m,
            ),
          );
        },
        onError: (message) => {
          setStatusBanner(`⚠ ${message}`);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? { ...m, status: "error", error: message }
                : m,
            ),
          );
        },
        onDone: ({ content, provider, providerDetail }) => {
          const totalMs = Date.now() - startedAt;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? {
                    ...m,
                    content: content || m.content,
                    status: content ? "complete" : "error",
                    provider: provider ?? m.provider,
                    providerDetail: providerDetail ?? m.providerDetail,
                    totalMs,
                  }
                : m,
            ),
          );
          // Refresh threads list to update lastMessageAt / counts
          loadThreads();
          // Auto-TTS
          if (ttsEnabled && content) speak(content, realAssistantId);
        },
      });
    },
    [
      ensureThread,
      selectedAgent,
      stream,
      activeThreadId,
      loadThreads,
      ttsEnabled,
      speak,
    ],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const wake = useWakeWord({
    enabled: wakeEnabled,
    paused: stream.isStreaming || speakingId !== null,
    phrases: WAKE_PHRASES,
    onWake: ({ command }) => {
      if (command.length >= 3) {
        setWakeTeaser(null);
        void handleSendRef.current?.(command);
      } else {
        setWakeTeaser("🎙 Pode falar — estou ouvindo seu comando.");
        setTimeout(() => setWakeTeaser(null), 10_000);
      }
    },
  });

  return (
    <div style={shellStyle}>
      <ThreadList
        threads={threads}
        activeId={activeThreadId}
        agents={agents}
        onSelect={handleSelectThread}
        onCreate={handleCreateThread}
        onPin={handleTogglePin}
        onDelete={handleDeleteThread}
      />

      <section style={mainStyle}>
        <header style={topBarStyle}>
          <div style={titleAreaStyle}>
            <h1 style={pageTitleStyle}>
              <Bot size={20} style={{ color: "var(--accent)" }} />
              {activeThread?.title ?? "Nova conversa"}
            </h1>
            <span style={pageSubStyle}>
              Powered by OpenClaw · {messages.length} mensagens
            </span>
          </div>
          <div style={controlsStyle}>
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              style={selectStyle}
              title="Agente ativo"
              disabled={stream.isStreaming}
            >
              {agents.length === 0 && <option value="main">main</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.emoji} {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                if (ttsEnabled) tts.cancel();
                setTtsEnabled((v) => !v);
              }}
              style={toggleButtonStyle(ttsEnabled)}
              title={
                ttsEnabled
                  ? `Voz automática ligada (${tts.voiceLabel})`
                  : `Voz automática desligada (${tts.voiceLabel})`
              }
            >
              {ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
              {ttsEnabled ? "Voz ON" : "Voz OFF"}
              {tts.engine === "elevenlabs" && (
                <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 2 }}>
                  · 11labs
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowVoiceModal(true)}
              style={toggleButtonStyle(false)}
              title="Configurar voz (ElevenLabs)"
            >
              <SettingsIcon size={14} />
            </button>
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              style={toggleButtonStyle(false)}
              title="Importar sessions do OpenClaw"
            >
              <Download size={16} />
              Importar
            </button>
            <WakeIndicator
              state={wake.state}
              enabled={wakeEnabled && wake.supported}
              phrases={WAKE_PHRASES}
              lastHeard={wake.lastHeard}
              onToggle={() => setWakeEnabled((v) => !v)}
            />
          </div>
        </header>

        <ImportOpenClawModal
          open={showImportModal}
          onClose={() => setShowImportModal(false)}
          onImported={loadThreads}
        />

        <VoiceSettingsModal
          open={showVoiceModal}
          onClose={() => {
            setShowVoiceModal(false);
            void tts.refresh();
          }}
        />

        <HeardPanel
          entries={wake.heardLog ?? []}
          enabled={wakeEnabled && wake.supported}
        />

        {statusBanner && (
          <div style={bannerStyle}>{statusBanner}</div>
        )}
        {wakeTeaser && (
          <div style={wakeTeaserStyle}>🎙 {wakeTeaser}</div>
        )}

        <div style={messageScrollStyle}>
          <div style={messageListStyle}>
            {messages.length === 0 && !stream.isStreaming && (
              <EmptyState />
            )}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                agent={agentById.get(m.role === "user" ? "" : (activeThread?.agent_id ?? selectedAgent))}
                onSpeak={(text) => speak(text, m.id)}
                isSpeaking={speakingId === m.id}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <Composer
          isStreaming={stream.isStreaming}
          onSend={handleSend}
          onStop={stream.stop}
          voiceLang="pt-BR"
        />
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={emptyStateStyle}>
      <Bot size={42} style={{ color: "var(--accent)" }} />
      <h2 style={{ margin: 0, fontSize: 20 }}>Pronto para conversar</h2>
      <p style={{ margin: 0, color: "var(--text-secondary)", maxWidth: 420 }}>
        Digite uma pergunta ou clique no microfone para falar.
        Diga &ldquo;Jarvis&rdquo; ou &ldquo;Atlas&rdquo; quando a wake word estiver ligada.
      </p>
    </div>
  );
}

const shellStyle: CSSProperties = {
  display: "flex",
  height: "calc(100vh - 48px - 32px - 48px)",
  margin: "-24px",
  borderRadius: 0,
  background: "var(--bg)",
};

const mainStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

const topBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 20px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};

const titleAreaStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const pageSubStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
};

const controlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const selectStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  fontSize: 13,
};

function toggleButtonStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 8,
    background: active ? "var(--accent-soft)" : "var(--bg)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "var(--accent)" : "var(--text-secondary)",
    fontSize: 12,
    cursor: "pointer",
  };
}

const bannerStyle: CSSProperties = {
  padding: "8px 20px",
  background: "var(--danger-soft, rgba(239,68,68,0.1))",
  borderBottom: "1px solid var(--danger, #ef4444)",
  color: "var(--danger, #ef4444)",
  fontSize: 12,
};

const wakeTeaserStyle: CSSProperties = {
  padding: "8px 20px",
  background: "var(--accent-soft)",
  borderBottom: "1px solid var(--accent)",
  color: "var(--accent)",
  fontSize: 12,
};

const messageScrollStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "20px 24px",
  background: "var(--bg)",
};

const messageListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  maxWidth: 980,
  margin: "0 auto",
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  padding: "60px 20px",
  color: "var(--text-secondary)",
  textAlign: "center",
};
