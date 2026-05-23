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
import { WakeWordSettingsModal } from "@/components/chat/WakeWordSettingsModal";
import { WakeIndicator } from "@/components/chat/WakeIndicator";
import { HeardPanel } from "@/components/chat/HeardPanel";
import { PushToTalkOverlay } from "@/components/chat/PushToTalkOverlay";
import { useChatStream } from "@/components/chat/useChatStream";
import { usePushToTalk } from "@/components/chat/usePushToTalk";
import { usePorcupineWakeWord } from "@/components/chat/usePorcupineWakeWord";
import { useOpenWakeWord } from "@/components/chat/useOpenWakeWord";
import { useFollowUpCapture } from "@/components/chat/useFollowUpCapture";
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
  const [showWakeModal, setShowWakeModal] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(true);
  const [wakeTeaser, setWakeTeaser] = useState<string | null>(null);
  /**
   * Persistent diagnostics inferred from the last few assistant turns:
   *  - `buffered`: the OpenClaw gateway buffered the whole reply
   *    (1st-delta arrived together with final). Needs
   *    `agents.defaults.blockStreamingDefault: "on"` server-side.
   *  - `stubReply`: the agent answered with a stub like "Respondi no chat",
   *    meaning AGENTS.md/TOOLS.md is routing the real answer elsewhere.
   */
  const [agentDiagnostics, setAgentDiagnostics] = useState<{
    buffered: boolean;
    stubReply: boolean;
  }>({ buffered: false, stubReply: false });
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

  // Last user prompt powers the "Forçar resposta direta" retry button:
  // when the agent answered with a stub, we resend the most recent user
  // turn with `forceInline: true` so the server appends a routing hint.
  const lastUserPrompt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.content?.trim()) return m.content;
    }
    return null;
  }, [messages]);

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
    async (text: string, opts?: { forceInline?: boolean }) => {
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
        forceInline: opts?.forceInline,
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
        onProvider: ({ provider, detail, buffered }) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? { ...m, provider, providerDetail: detail, buffered }
                : m,
            ),
          );
          if (buffered) {
            setAgentDiagnostics((d) => ({ ...d, buffered: true }));
          }
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
        onDone: ({ content, provider, providerDetail, buffered, stubReply }) => {
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
                    buffered: buffered ?? m.buffered,
                    stubReply: stubReply ?? m.stubReply,
                    totalMs,
                  }
                : m,
            ),
          );
          if (buffered || stubReply) {
            setAgentDiagnostics((d) => ({
              buffered: d.buffered || !!buffered,
              stubReply: d.stubReply || !!stubReply,
            }));
          }
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

  const pushToTalk = usePushToTalk({
    enabled: !stream.isStreaming,
    onCommand: (text) => {
      void handleSendRef.current?.(text);
    },
  });

  // Captures the spoken command after Porcupine detects the wake word.
  // Porcupine only signals "wake" — we still need an ASR to transcribe
  // what the user said next. Web Speech is reliable for full sentences;
  // we only fight pt-BR mistranscription on isolated trigger words.
  const followUp = useFollowUpCapture({
    onCommand: (text) => {
      setWakeTeaser(null);
      void handleSendRef.current?.(text);
    },
    onCancel: () => {
      setWakeTeaser(null);
    },
  });

  // The chat page supports two acoustic wake engines: openWakeWord
  // (Apache-2.0 default — runs ONNX models in the browser, no setup)
  // and Picovoice Porcupine (free tier, more accurate but requires
  // an AccessKey). The user picks via WakeWordSettingsModal; we read
  // the choice from /api/chat/wake-config and activate one hook at a
  // time so they don't fight for the microphone.
  const [wakeEngine, setWakeEngine] = useState<"openwakeword" | "porcupine">("openwakeword");
  const [openWakeThreshold, setOpenWakeThreshold] = useState(0.5);

  const refreshWakeConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/wake-config");
      if (!res.ok) return;
      const data = (await res.json()) as {
        engine?: "openwakeword" | "porcupine";
        openwakeword?: { threshold?: number };
      };
      if (data.engine === "openwakeword" || data.engine === "porcupine") {
        setWakeEngine(data.engine);
      }
      if (typeof data.openwakeword?.threshold === "number") {
        setOpenWakeThreshold(data.openwakeword.threshold);
      }
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => {
    void refreshWakeConfig();
  }, [refreshWakeConfig]);

  const handleWakeFired = useCallback(() => {
    setWakeTeaser("🎙 Detectado! Pode falar seu comando.");
    followUp.arm();
  }, [followUp]);

  const openWake = useOpenWakeWord({
    enabled: wakeEnabled && wakeEngine === "openwakeword",
    paused:
      stream.isStreaming ||
      speakingId !== null ||
      pushToTalk.holding ||
      followUp.active,
    threshold: openWakeThreshold,
    onWake: handleWakeFired,
  });

  const porcupine = usePorcupineWakeWord({
    enabled: wakeEnabled && wakeEngine === "porcupine",
    paused:
      stream.isStreaming ||
      speakingId !== null ||
      pushToTalk.holding ||
      followUp.active,
    onWake: handleWakeFired,
  });

  // Web Speech wake is only used when no acoustic engine is active —
  // its pt-BR accuracy is poor, so we keep it as a last-resort fallback
  // when openWakeWord and Porcupine are both off.
  const acousticActive =
    (wakeEngine === "openwakeword" && openWake.holding) ||
    (wakeEngine === "porcupine" && porcupine.holding);
  const webSpeechWakeActive = wakeEnabled && !acousticActive;

  const wake = useWakeWord({
    enabled: webSpeechWakeActive,
    paused:
      stream.isStreaming ||
      speakingId !== null ||
      pushToTalk.holding ||
      openWake.holding ||
      porcupine.holding,
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
              {(tts.engine === "elevenlabs" || tts.engine === "fishaudio") && (
                <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 2 }}>
                  · {tts.engine === "fishaudio" ? "fish" : "11labs"}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowVoiceModal(true)}
              style={toggleButtonStyle(false)}
              title="Configurar voz (ElevenLabs / Fish Audio)"
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
              state={
                wakeEngine === "openwakeword"
                  ? openWake.state === "listening"
                    ? "listening"
                    : openWake.state === "activated"
                    ? "activated"
                    : openWake.state === "loading"
                    ? "listening"
                    : openWake.state === "error"
                    ? "error"
                    : wake.state
                  : porcupine.available
                  ? porcupine.state === "listening"
                    ? "listening"
                    : porcupine.state === "activated"
                    ? "activated"
                    : porcupine.state === "loading"
                    ? "listening"
                    : porcupine.state === "error"
                    ? "error"
                    : wake.state
                  : wake.state
              }
              enabled={wakeEnabled}
              phrases={
                wakeEngine === "openwakeword"
                  ? ["Hey Jarvis (openWakeWord)"]
                  : porcupine.available
                  ? ["Jarvis (Porcupine)"]
                  : WAKE_PHRASES
              }
              lastHeard={
                wakeEngine === "openwakeword"
                  ? openWake.errorMessage
                    ? openWake.errorMessage
                    : `score ${openWake.lastScore.toFixed(2)}`
                  : porcupine.available
                  ? porcupine.errorMessage || "Porcupine ativo"
                  : wake.lastHeard
              }
              onToggle={() => setWakeEnabled((v) => !v)}
            />
            <button
              type="button"
              onClick={() => setShowWakeModal(true)}
              style={toggleButtonStyle(false)}
              title="Configurar wake word (Picovoice)"
            >
              ⚙ Wake
            </button>
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

        <WakeWordSettingsModal
          open={showWakeModal}
          onClose={() => {
            setShowWakeModal(false);
            void refreshWakeConfig();
          }}
        />

        <HeardPanel
          entries={wake.heardLog ?? []}
          enabled={wakeEnabled && wake.supported}
        />

        <PushToTalkOverlay
          visible={pushToTalk.holding}
          interim={pushToTalk.interim}
        />

        {statusBanner && (
          <div style={bannerStyle}>{statusBanner}</div>
        )}
        {tts.lastError && (
          <div style={bannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span>
                ⚠ TTS ({tts.engine}) falhou — usando voz do browser como fallback.{" "}
                <strong>Detalhe:</strong> {tts.lastError}
              </span>
              <button
                type="button"
                onClick={tts.clearError}
                style={{
                  background: "transparent",
                  border: "1px solid var(--danger, #ef4444)",
                  borderRadius: 4,
                  color: "var(--danger, #ef4444)",
                  fontSize: 10,
                  padding: "2px 8px",
                  cursor: "pointer",
                }}
              >
                Dispensar
              </button>
            </span>
          </div>
        )}
        {wakeTeaser && (
          <div style={wakeTeaserStyle}>🎙 {wakeTeaser}</div>
        )}
        {agentDiagnostics.buffered && (
          <div style={diagnosticBannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span>
                <strong>⚡ Latência: gateway está bufferizando a resposta inteira</strong>
                <br />
                Para streaming real (1º token em ~2s), edite{" "}
                <code style={inlineCodeStyle}>~/.openclaw/openclaw.json</code> no servidor e adicione em{" "}
                <code style={inlineCodeStyle}>agents.defaults</code>:
                <pre style={preStyle}>{BUFFERED_CONFIG_SNIPPET}</pre>
                Depois: <code style={inlineCodeStyle}>systemctl restart openclaw-gateway</code>
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(BUFFERED_CONFIG_SNIPPET);
                      setStatusBanner("✓ Config copiada — cole em ~/.openclaw/openclaw.json");
                      setTimeout(() => setStatusBanner((s) => (s?.startsWith("✓ Config") ? null : s)), 4000);
                    } catch {
                      setStatusBanner("⚠ Não foi possível copiar — copie manualmente");
                    }
                  }}
                  style={primaryBtnStyle}
                >
                  Copiar JSON
                </button>
                <button
                  type="button"
                  onClick={() => setAgentDiagnostics((d) => ({ ...d, buffered: false }))}
                  style={dismissBtnStyle}
                >
                  Dispensar
                </button>
              </span>
            </span>
          </div>
        )}
        {agentDiagnostics.stubReply && (
          <div style={diagnosticBannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span>
                <strong>⚠ Agente respondeu como notificação (&ldquo;Respondi no chat&rdquo;)</strong>
                <br />
                Isso indica que o <code style={inlineCodeStyle}>AGENTS.md</code> /{" "}
                <code style={inlineCodeStyle}>TOOLS.md</code> do agente <code style={inlineCodeStyle}>main</code>{" "}
                está roteando a resposta real para outro canal (ex: Telegram) e tratando esta sessão como notificação.
                Verifique em <code style={inlineCodeStyle}>~/.openclaw/workspace/AGENTS.md</code> se há regras
                de rota condicionais por <code style={inlineCodeStyle}>sessionKey</code>, e remova/ajuste para
                que <code style={inlineCodeStyle}>web:atlasdeck</code> seja tratado como chat direto.
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={stream.isStreaming || !lastUserPrompt}
                  onClick={() => {
                    if (!lastUserPrompt) return;
                    setAgentDiagnostics((d) => ({ ...d, stubReply: false }));
                    void handleSend(lastUserPrompt, { forceInline: true });
                  }}
                  style={{
                    ...primaryBtnStyle,
                    opacity: stream.isStreaming || !lastUserPrompt ? 0.5 : 1,
                    cursor: stream.isStreaming || !lastUserPrompt ? "not-allowed" : "pointer",
                  }}
                  title={
                    !lastUserPrompt
                      ? "Nenhuma pergunta recente"
                      : "Reenvia a última pergunta com hint forçando o agente a responder aqui"
                  }
                >
                  Forçar resposta direta
                </button>
                <button
                  type="button"
                  onClick={() => setAgentDiagnostics((d) => ({ ...d, stubReply: false }))}
                  style={dismissBtnStyle}
                >
                  Dispensar
                </button>
              </span>
            </span>
          </div>
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
      <p style={{ margin: 0, color: "var(--text-secondary)", maxWidth: 520 }}>
        Quatro formas de falar com o Jarvis:
      </p>
      <ul style={emptyStateListStyle}>
        <li>
          <strong>Diga &ldquo;Jarvis&rdquo;</strong> com Porcupine ativo —
          detecção acústica precisa, ignora o ASR do Chrome. Configure em{" "}
          <kbd style={kbdStyle}>⚙ Wake</kbd> no topo.
        </li>
        <li>
          <kbd style={kbdStyle}>ESPAÇO</kbd> — segure para falar, solte para
          enviar (fallback sem setup)
        </li>
        <li>
          🎙 clique no microfone do composer para gravar manualmente
        </li>
        <li>
          fallback sem Porcupine: dizer &ldquo;Atlas …&rdquo; em voz alta —
          <em> Web Speech pt-BR pode não pegar a palavra, prefira Porcupine.</em>
        </li>
      </ul>
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

const diagnosticBannerStyle: CSSProperties = {
  padding: "10px 20px",
  background: "rgba(245, 158, 11, 0.12)",
  borderBottom: "1px solid #f59e0b",
  color: "#f59e0b",
  fontSize: 12,
  lineHeight: 1.5,
};

const inlineCodeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  background: "rgba(0,0,0,0.25)",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 11,
};

const preStyle: CSSProperties = {
  margin: "6px 0",
  padding: "8px 10px",
  background: "rgba(0,0,0,0.35)",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-primary)",
  overflowX: "auto",
};

const dismissBtnStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #f59e0b",
  borderRadius: 4,
  color: "#f59e0b",
  fontSize: 10,
  padding: "2px 8px",
  cursor: "pointer",
  flexShrink: 0,
};

const primaryBtnStyle: CSSProperties = {
  background: "#f59e0b",
  border: "1px solid #f59e0b",
  borderRadius: 4,
  color: "#1f1408",
  fontSize: 10,
  fontWeight: 600,
  padding: "3px 8px",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const BUFFERED_CONFIG_SNIPPET = `"blockStreamingDefault": "on",
"blockStreamingBreak": "text_end",
"blockStreamingChunk": { "minChars": 50, "maxChars": 200 }`;

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

const emptyStateListStyle: CSSProperties = {
  textAlign: "left",
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 480,
  fontSize: 13,
  color: "var(--text-secondary)",
};

const kbdStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
};
