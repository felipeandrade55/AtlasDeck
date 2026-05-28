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
import { Bot, Download, Radio, Settings as SettingsIcon, Volume2, VolumeX } from "lucide-react";
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
import { useConversationMode } from "@/components/chat/useConversationMode";
import { usePushToTalk } from "@/components/chat/usePushToTalk";
import { usePorcupineWakeWord } from "@/components/chat/usePorcupineWakeWord";
import { useOpenWakeWord } from "@/components/chat/useOpenWakeWord";
import { useFollowUpCapture } from "@/components/chat/useFollowUpCapture";
import { useTtsEngine } from "@/components/chat/useTtsEngine";
import { useWakeWord } from "@/components/chat/useWakeWord";

// "Atlas" is a real Portuguese word — pt-BR ASR transcribes it
// reliably. "Jarvis" is kept as a secondary option (often mistranscribed
// as jesus/jovis/jarves — covered by aliases in useWakeWord). Users
// invoke it with prefixes like "ei jarvis", "hey jarvis", "olá jarvis":
// findWakeMatch only requires the alias itself to appear with a word
// boundary, so the prefix is handled automatically.
const WAKE_PHRASES = ["Atlas", "Jarvis"];
const WAKE_PHRASE_LABELS = ["ei Jarvis", "Atlas"];
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
  // Default: TTS auto-speak ON. The user explicitly asked for the page
  // to be ready to talk + listen as soon as it opens, no clicks needed.
  // The cloud TTS (Fish Audio / ElevenLabs) is loaded lazily by
  // useTtsEngine, so flipping this on at mount only triggers playback
  // *after* the assistant produces a reply.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [showWakeModal, setShowWakeModal] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(true);
  const [wakeTeaser, setWakeTeaser] = useState<string | null>(null);
  // "Modo Conversa" — hands-free voice loop without wake-word. When ON,
  // every utterance the user speaks is auto-sent to the chat; the wake
  // path is suspended to avoid two SpeechRecognition instances fighting
  // over the same mic (Chrome only allows one per tab). See
  // useConversationMode for the loop semantics.
  const [conversationActive, setConversationActive] = useState(false);
  // Tracks which transport answered the last turn. Drives the top-bar
  // transport badge so the user can see at a glance whether real-time
  // WS is actually being used vs. the legacy CLI/Ollama fallback.
  const [lastTransport, setLastTransport] = useState<
    "ws" | "cli" | "ollama" | "unknown" | null
  >(null);
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
    heartbeatLeak: boolean;
    deviceRequired: boolean;
  }>({ buffered: false, stubReply: false, heartbeatLeak: false, deviceRequired: false });
  // Tracks an in-flight "Corrigir automaticamente" call so the buttons
  // disable themselves and show progress while the server applies the
  // fix. Distinct keys so streaming + heartbeat fixes can run
  // independently without each other's spinners getting confused.
  const [autoFixBusy, setAutoFixBusy] = useState<
    null | "streaming" | "heartbeat" | "auth" | "all"
  >(null);
  const [autoFixResult, setAutoFixResult] = useState<string | null>(null);
  // Pre-emptive health check: when the chat page loads we ping the
  // server for a non-mutating diagnostic. If something is off (no
  // streaming config or no heartbeat guard) the relevant banner is
  // shown immediately, so the user can fix things BEFORE talking to
  // the agent and seeing the broken behaviour.
  const [healthCheck, setHealthCheck] = useState<{
    streamingOk: boolean;
    heartbeatGuardOk: boolean;
    backendAuthOk: boolean;
  } | null>(null);

  const [thinkingMode, setThinkingMode] = useState<"reasoning" | "instant">("instant");

  useEffect(() => {
    const saved = localStorage.getItem("atlas_chat_thinking_mode");
    if (saved === "reasoning") {
      setThinkingMode("reasoning");
    } else if (saved === "instant") {
      setThinkingMode("instant");
    }
  }, []);

  const toggleThinkingMode = () => {
    setThinkingMode((prev) => {
      const next = prev === "reasoning" ? "instant" : "reasoning";
      localStorage.setItem("atlas_chat_thinking_mode", next);
      return next;
    });
  };

  const runAutoFix = useCallback(
    async (which: "streaming" | "heartbeat" | "auth" | "all") => {
      if (autoFixBusy) return;
      setAutoFixBusy(which);
      setAutoFixResult(null);
      try {
        const res = await fetch("/api/openclaw/auto-fix", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fix: which, restart: true }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          applied: string[];
          streaming?: { alreadyCorrect: boolean; error?: string };
          heartbeat?: { alreadyCorrect: boolean; error?: string };
          auth?: { alreadyCorrect: boolean; error?: string };
          restart?: { ok: boolean; method: string; detail: string; error?: string };
        };
        if (!data.ok) {
          const err =
            data.streaming?.error ||
            data.auth?.error ||
            data.heartbeat?.error ||
            data.restart?.error ||
            "falha desconhecida";
          setAutoFixResult(`⚠ Auto-fix falhou: ${err}`);
        } else if (data.applied.length === 0) {
          setAutoFixResult("✓ Config já estava correta — nada a fazer.");
          // Dismiss the relevant banners since they're actually clean now.
          setAgentDiagnostics((d) => ({
            ...d,
            buffered: which === "streaming" || which === "all" ? false : d.buffered,
            heartbeatLeak: which === "heartbeat" || which === "all" ? false : d.heartbeatLeak,
            deviceRequired: which === "auth" || which === "all" ? false : d.deviceRequired,
          }));
        } else {
          const parts = data.applied.map((a) =>
            a === "streaming"
              ? "streaming"
              : a === "auth"
              ? "auth (device bypass)"
              : "heartbeat guard",
          );
          const restartMsg = data.restart
            ? data.restart.ok
              ? ` · gateway reiniciado (${data.restart.method})`
              : ` · ⚠ ${
                  data.restart.detail
                }. Reinicie manualmente: systemctl --user restart openclaw-gateway`
            : "";
          setAutoFixResult(`✓ Aplicado: ${parts.join(", ")}${restartMsg}`);
          // Clear the banners that were causing this to be needed —
          // the auto-fix already addressed them.
          setAgentDiagnostics((d) => ({
            ...d,
            buffered: which === "streaming" || which === "all" ? false : d.buffered,
            heartbeatLeak: which === "heartbeat" || which === "all" ? false : d.heartbeatLeak,
            deviceRequired: which === "auth" || which === "all" ? false : d.deviceRequired,
          }));
          // Refresh health snapshot so the proactive banners disappear.
          try {
            const hc = await fetch("/api/openclaw/health-check");
            if (hc.ok) {
              const j = (await hc.json()) as {
                streamingOk: boolean;
                heartbeatGuardOk: boolean;
                backendAuthOk: boolean;
              };
              setHealthCheck({
                streamingOk: j.streamingOk,
                heartbeatGuardOk: j.heartbeatGuardOk,
                backendAuthOk: j.backendAuthOk,
              });
            }
          } catch {
            // ignore — banner just stays until next reload
          }
        }
        // Auto-dismiss the result toast after ~6s
        setTimeout(() => setAutoFixResult((r) => (r ? null : r)), 6000);
      } catch (err) {
        setAutoFixResult(`⚠ Auto-fix falhou: ${(err as Error).message}`);
      } finally {
        setAutoFixBusy(null);
      }
    },
    [autoFixBusy],
  );

  // Run the proactive health check once when the chat mounts. Failures
  // here are non-fatal — the banners that fire on actual issues are the
  // hard fallback.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/openclaw/health-check");
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as {
          streamingOk: boolean;
          heartbeatGuardOk: boolean;
          backendAuthOk: boolean;
        };
        if (!cancelled) {
          setHealthCheck({
            streamingOk: j.streamingOk,
            heartbeatGuardOk: j.heartbeatGuardOk,
            backendAuthOk: j.backendAuthOk,
          });
        }
      } catch {
        // ignore — proactive nag is best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
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
        thinking: thinkingMode === "instant" ? "off" : undefined,
        fastMode: thinkingMode === "instant" ? true : undefined,
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
          if (provider === "ws" || provider === "cli" || provider === "ollama") {
            setLastTransport(provider);
          } else {
            setLastTransport("unknown");
          }
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
        onError: (message, code) => {
          // Map the well-known WS_DEVICE_REQUIRED into a diagnostic
          // banner instead of a generic red error — the user can then
          // click "Corrigir automaticamente" to apply the
          // dangerouslyDisableDeviceAuth flag.
          if (code === "WS_DEVICE_REQUIRED") {
            setAgentDiagnostics((d) => ({ ...d, deviceRequired: true }));
          }
          setStatusBanner(`⚠ ${message}`);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realAssistantId
                ? { ...m, status: "error", error: message }
                : m,
            ),
          );
        },
        onDone: ({ content, provider, providerDetail, buffered, stubReply, heartbeatLeak }) => {
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
          if (buffered || stubReply || heartbeatLeak) {
            setAgentDiagnostics((d) => ({
              ...d,
              buffered: d.buffered || !!buffered,
              stubReply: d.stubReply || !!stubReply,
              heartbeatLeak: d.heartbeatLeak || !!heartbeatLeak,
            }));
          }
          // Refresh threads list to update lastMessageAt / counts
          loadThreads();
          // Auto-TTS — but suppress when the agent leaked its system
          // prompt. The user shouldn't hear "Read HEARTBEAT.md..."
          // spoken back; the banner already surfaces the situation
          // in text form.
          if (ttsEnabled && content && !heartbeatLeak) {
            speak(content, realAssistantId);
          }
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
    // Space-bar push-to-talk and Modo Conversa would race for the same
    // SpeechRecognition slot; suspend push-to-talk while conversation
    // mode owns the mic. The user can still type during streams.
    enabled: !stream.isStreaming && !conversationActive,
    onCommand: (text) => {
      void handleSendRef.current?.(text);
    },
  });

  // Hands-free conversation loop. `paused` covers both the round-trip
  // (so we don't keep listening while the request is in flight) and TTS
  // playback (so the assistant's own voice doesn't feed back into the
  // mic). When TTS finishes and the stream settles, `paused` flips to
  // false and the hook re-opens the mic transparently.
  const conversation = useConversationMode({
    active: conversationActive,
    paused: stream.isStreaming || speakingId !== null,
    onUtterance: (text) => {
      setStatusBanner(null);
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
    // Modo Conversa owns the mic exclusively while engaged — keep the
    // wake-word path fully disabled so the ONNX worker doesn't compete
    // for the same MediaStream and trip the recogniser.
    enabled: wakeEnabled && !conversationActive && wakeEngine === "openwakeword",
    paused:
      stream.isStreaming ||
      speakingId !== null ||
      pushToTalk.holding ||
      followUp.active,
    threshold: openWakeThreshold,
    onWake: handleWakeFired,
  });

  const porcupine = usePorcupineWakeWord({
    enabled: wakeEnabled && !conversationActive && wakeEngine === "porcupine",
    paused:
      stream.isStreaming ||
      speakingId !== null ||
      pushToTalk.holding ||
      followUp.active,
    onWake: handleWakeFired,
  });

  // Web Speech is the always-on fallback. It activates whenever no
  // acoustic engine is currently holding the mic — including the case
  // where openWakeWord crashed during WASM init (state="error",
  // holding=false). The user explicitly asked the page to listen the
  // moment it loads, so we never want to leave it silent: when the
  // acoustic path fails, Web Speech takes over transparently with the
  // pt-BR aliases for "jarvis" / "atlas".
  const acousticActive =
    (wakeEngine === "openwakeword" && openWake.holding) ||
    (wakeEngine === "porcupine" && porcupine.holding);
  const acousticFailed =
    (wakeEngine === "openwakeword" && openWake.state === "error") ||
    (wakeEngine === "porcupine" && porcupine.state === "error");
  const webSpeechWakeActive = wakeEnabled && !acousticActive;

  const wake = useWakeWord({
    // Same exclusivity rule applies to the Web Speech wake fallback:
    // Chrome allows a single SpeechRecognition per tab, so Modo Conversa
    // and the wake recogniser cannot coexist.
    enabled: webSpeechWakeActive && !conversationActive,
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
              <TransportBadge transport={lastTransport} streaming={stream.isStreaming} />
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
                // Toggling on requires a user gesture so the browser
                // grants mic access for the long-lived recogniser
                // session — that's why this lives on a click, not on
                // a useEffect. Turning off keeps the gesture too.
                setConversationActive((v) => {
                  const next = !v;
                  if (next) {
                    setStatusBanner("🎙 Modo Conversa ativado — fale à vontade, sem precisar de wake word.");
                    setTimeout(
                      () =>
                        setStatusBanner((s) =>
                          s?.startsWith("🎙 Modo Conversa ativado") ? null : s,
                        ),
                      4000,
                    );
                  }
                  return next;
                });
              }}
              style={conversationButtonStyle(conversationActive, conversation.listening)}
              title={
                !conversation.supported
                  ? "Web Speech API não suportado neste navegador (use Chrome/Edge)"
                  : conversationActive
                  ? conversation.listening
                    ? "Modo Conversa ouvindo — clique para parar"
                    : "Modo Conversa pausado (aguardando resposta) — clique para parar"
                  : "Modo Conversa: fale livre, sem precisar dizer 'ei Jarvis'"
              }
              disabled={!conversation.supported}
            >
              <Radio size={16} />
              {conversationActive
                ? conversation.listening
                  ? "Conversa LIVE"
                  : "Conversa ⏸"
                : "Conversa"}
            </button>
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
              onClick={toggleThinkingMode}
              style={toggleButtonStyle(thinkingMode === "instant")}
              title={
                thinkingMode === "instant"
                  ? "Modo Instantâneo (Ultra-rápido, thinking desligado). Clique para mudar para Modo Raciocínio."
                  : "Modo Raciocínio (Mais inteligente, gpt-5.5 com thinking ativo). Clique para mudar para Modo Instantâneo."
              }
            >
              {thinkingMode === "instant" ? "⚡ Rápido" : "🧠 Raciocínio"}
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
                // When the acoustic engine (openWakeWord / Porcupine)
                // crashed, the page transparently uses Web Speech as
                // the wake source — the indicator must reflect THAT
                // state, otherwise the user stares at a red error
                // even though we're actually listening via Web Speech.
                acousticFailed
                  ? wake.state
                  : wakeEngine === "openwakeword"
                  ? openWake.state === "listening"
                    ? "listening"
                    : openWake.state === "activated"
                    ? "activated"
                    : openWake.state === "loading"
                    ? "listening"
                    : wake.state
                  : porcupine.available
                  ? porcupine.state === "listening"
                    ? "listening"
                    : porcupine.state === "activated"
                    ? "activated"
                    : porcupine.state === "loading"
                    ? "listening"
                    : wake.state
                  : wake.state
              }
              enabled={wakeEnabled}
              phrases={
                acousticFailed
                  ? WAKE_PHRASE_LABELS
                  : wakeEngine === "openwakeword"
                  ? ["Hey Jarvis (openWakeWord)"]
                  : porcupine.available
                  ? ["Jarvis (Porcupine)"]
                  : WAKE_PHRASE_LABELS
              }
              lastHeard={
                acousticFailed
                  ? wake.lastHeard || "ouvindo via Web Speech"
                  : wakeEngine === "openwakeword"
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
        {conversationActive && (
          <div style={conversationBannerStyle(conversation.listening)}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Radio size={14} />
              {conversation.errorMessage ? (
                <>
                  <strong>Modo Conversa erro:</strong>
                  <span>{conversation.errorMessage}</span>
                </>
              ) : conversation.listening ? (
                <>
                  <strong>Modo Conversa</strong>
                  <span style={{ opacity: 0.85 }}>
                    {conversation.interim
                      ? `🎙 ouvindo: "${conversation.interim}"`
                      : "ouvindo… fale e a frase é enviada quando você pausar 1.5s"}
                  </span>
                </>
              ) : (
                <>
                  <strong>Modo Conversa</strong>
                  <span style={{ opacity: 0.85 }}>
                    {stream.isStreaming
                      ? "aguardando resposta…"
                      : speakingId
                      ? "Jarvis falando — retomando após o áudio"
                      : "pausado"}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setConversationActive(false)}
              style={dismissBtnStyle}
            >
              Encerrar
            </button>
          </div>
        )}
        {wakeTeaser && (
          <div style={wakeTeaserStyle}>🎙 {wakeTeaser}</div>
        )}
        {autoFixResult && (
          <div
            style={{
              ...wakeTeaserStyle,
              background: autoFixResult.startsWith("✓")
                ? "rgba(16,185,129,0.10)"
                : "rgba(245,158,11,0.10)",
              borderBottom: `1px solid ${
                autoFixResult.startsWith("✓") ? "#10b981" : "#f59e0b"
              }`,
              color: autoFixResult.startsWith("✓") ? "#10b981" : "#f59e0b",
            }}
          >
            {autoFixResult}
          </div>
        )}
        {agentDiagnostics.deviceRequired && (
          <div style={diagnosticBannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span>
                <strong>🔒 Gateway exige device identity</strong>
                <br />
                O OpenClaw rejeitou o handshake do AtlasDeck com{" "}
                <code style={inlineCodeStyle}>device identity required</code> — bug
                conhecido (openclaw/openclaw#40812). Para instalações pessoais é
                seguro habilitar{" "}
                <code style={inlineCodeStyle}>dangerouslyDisableDeviceAuth</code> no{" "}
                <code style={inlineCodeStyle}>openclaw.json</code>, e o AtlasDeck
                pode fazer isso pra você + reiniciar o gateway.
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={autoFixBusy !== null}
                  onClick={() => runAutoFix("auth")}
                  style={{
                    ...primaryBtnStyle,
                    opacity: autoFixBusy !== null ? 0.5 : 1,
                    cursor: autoFixBusy !== null ? "wait" : "pointer",
                  }}
                  title="Adiciona dangerouslyDisableDeviceAuth ao openclaw.json + reinicia o gateway"
                >
                  {autoFixBusy === "auth" ? "Aplicando..." : "Corrigir automaticamente"}
                </button>
                <button
                  type="button"
                  onClick={() => setAgentDiagnostics((d) => ({ ...d, deviceRequired: false }))}
                  style={dismissBtnStyle}
                >
                  Dispensar
                </button>
              </span>
            </span>
          </div>
        )}
        {healthCheck &&
          !healthCheck.backendAuthOk &&
          !agentDiagnostics.deviceRequired && (
            <div style={diagnosticBannerStyle}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <span>
                  <strong>ℹ Bypass de device-auth não está ligado no gateway</strong>
                  <br />
                  Sem essa flag o gateway pode rejeitar o WS do AtlasDeck com{" "}
                  <code style={inlineCodeStyle}>device identity required</code>{" "}
                  (depende da versão do OpenClaw). Quer ligar agora?
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    disabled={autoFixBusy !== null}
                    onClick={() => runAutoFix("auth")}
                    style={{
                      ...primaryBtnStyle,
                      opacity: autoFixBusy !== null ? 0.5 : 1,
                      cursor: autoFixBusy !== null ? "wait" : "pointer",
                    }}
                  >
                    {autoFixBusy === "auth" ? "Aplicando..." : "Ligar bypass"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setHealthCheck((h) =>
                        h ? { ...h, backendAuthOk: true } : h,
                      )
                    }
                    style={dismissBtnStyle}
                  >
                    Dispensar
                  </button>
                </span>
              </span>
            </div>
          )}
        {healthCheck &&
          !healthCheck.streamingOk &&
          !agentDiagnostics.buffered && (
            <div style={diagnosticBannerStyle}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <span>
                  <strong>ℹ Streaming não está ligado no OpenClaw</strong>
                  <br />
                  Detectei que <code style={inlineCodeStyle}>blockStreaming</code> está
                  desligado no <code style={inlineCodeStyle}>~/.openclaw/openclaw.json</code>.
                  Sem ele, a resposta vem só depois de pronta (5–10s de espera). Posso
                  ligar agora pra você?
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    disabled={autoFixBusy !== null}
                    onClick={() => runAutoFix("streaming")}
                    style={{
                      ...primaryBtnStyle,
                      opacity: autoFixBusy !== null ? 0.5 : 1,
                      cursor: autoFixBusy !== null ? "wait" : "pointer",
                    }}
                  >
                    {autoFixBusy === "streaming" ? "Aplicando..." : "Ligar streaming"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setHealthCheck((h) => (h ? { ...h, streamingOk: true } : h))
                    }
                    style={dismissBtnStyle}
                  >
                    Dispensar
                  </button>
                </span>
              </span>
            </div>
          )}
        {healthCheck &&
          !healthCheck.heartbeatGuardOk &&
          !agentDiagnostics.heartbeatLeak && (
            <div style={diagnosticBannerStyle}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <span>
                  <strong>ℹ Guard do HEARTBEAT ainda não foi instalado</strong>
                  <br />
                  Sem essa proteção no <code style={inlineCodeStyle}>AGENTS.md</code> o
                  agente pode confundir mensagens normais (&ldquo;bom dia&rdquo;) com o
                  ping do cron das 7h e responder o template em vez da pergunta. Posso
                  instalar agora?
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    disabled={autoFixBusy !== null}
                    onClick={() => runAutoFix("heartbeat")}
                    style={{
                      ...primaryBtnStyle,
                      opacity: autoFixBusy !== null ? 0.5 : 1,
                      cursor: autoFixBusy !== null ? "wait" : "pointer",
                    }}
                  >
                    {autoFixBusy === "heartbeat" ? "Aplicando..." : "Instalar guard"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setHealthCheck((h) =>
                        h ? { ...h, heartbeatGuardOk: true } : h,
                      )
                    }
                    style={dismissBtnStyle}
                  >
                    Dispensar
                  </button>
                </span>
              </span>
            </div>
          )}
        {agentDiagnostics.buffered && (
          <div style={diagnosticBannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span>
                <strong>⚡ Latência: gateway está bufferizando a resposta inteira</strong>
                <br />
                Para streaming real (1º token em ~2s) é preciso ligar{" "}
                <code style={inlineCodeStyle}>blockStreaming</code> em{" "}
                <code style={inlineCodeStyle}>~/.openclaw/openclaw.json</code>. O
                AtlasDeck pode fazer isso pra você no servidor — clique no botão.
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={autoFixBusy !== null}
                  onClick={() => runAutoFix("streaming")}
                  style={{
                    ...primaryBtnStyle,
                    opacity: autoFixBusy !== null ? 0.5 : 1,
                    cursor: autoFixBusy !== null ? "wait" : "pointer",
                  }}
                  title="Edita openclaw.json + reinicia o gateway, sem abrir o terminal"
                >
                  {autoFixBusy === "streaming" ? "Aplicando..." : "Corrigir automaticamente"}
                </button>
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
                  style={dismissBtnStyle}
                  title="Backup: copia o JSON pra você colar manualmente"
                >
                  Copiar JSON (manual)
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
        {agentDiagnostics.heartbeatLeak && (
          <div style={diagnosticBannerStyle}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span>
                <strong>⚠ Agente vazou o template HEARTBEAT no lugar da resposta</strong>
                <br />
                A resposta retornada parece ser o próprio system prompt
                (&ldquo;Read HEARTBEAT.md...&rdquo;) em vez de uma resposta à sua mensagem.
                O AtlasDeck pode corrigir isso pra você adicionando uma regra
                condicional no <code style={inlineCodeStyle}>AGENTS.md</code> que só
                dispara o heartbeat quando a mensagem é literalmente{" "}
                <code style={inlineCodeStyle}>HEARTBEAT</code> ou{" "}
                <code style={inlineCodeStyle}>PING</code>.
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={autoFixBusy !== null}
                  onClick={() => runAutoFix("heartbeat")}
                  style={{
                    ...primaryBtnStyle,
                    opacity: autoFixBusy !== null ? 0.5 : 1,
                    cursor: autoFixBusy !== null ? "wait" : "pointer",
                  }}
                  title="Adiciona guard ao AGENTS.md + reinicia o gateway, sem abrir o terminal"
                >
                  {autoFixBusy === "heartbeat" ? "Aplicando..." : "Corrigir automaticamente"}
                </button>
                <button
                  type="button"
                  disabled={stream.isStreaming || !lastUserPrompt}
                  onClick={() => {
                    if (!lastUserPrompt) return;
                    setAgentDiagnostics((d) => ({ ...d, heartbeatLeak: false }));
                    void handleSend(lastUserPrompt, { forceInline: true });
                  }}
                  style={{
                    ...dismissBtnStyle,
                    opacity: stream.isStreaming || !lastUserPrompt ? 0.5 : 1,
                    cursor: stream.isStreaming || !lastUserPrompt ? "not-allowed" : "pointer",
                  }}
                  title={
                    !lastUserPrompt
                      ? "Nenhuma pergunta recente"
                      : "Reenvia com hint inline (workaround temporário, sem editar AGENTS.md)"
                  }
                >
                  Reenviar com hint
                </button>
                <button
                  type="button"
                  onClick={() => setAgentDiagnostics((d) => ({ ...d, heartbeatLeak: false }))}
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
            {messages
              .filter((m) => {
                if (m.role === "tool_use" || m.role === "tool_result") {
                  const name = m.tool_name?.toLowerCase() || "";
                  const hiddenTools = ["message", "telegram_send", "whatsapp_send", "reply", "send"];
                  if (hiddenTools.includes(name)) return false;
                }
                return true;
              })
              .map((m) => (
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

function TransportBadge({
  transport,
  streaming,
}: {
  transport: "ws" | "cli" | "ollama" | "unknown" | null;
  streaming: boolean;
}) {
  if (!transport && !streaming) return null;
  const variants: Record<string, { label: string; color: string; bg: string }> = {
    ws: { label: "WS real-time", color: "#10b981", bg: "rgba(16, 185, 129, 0.12)" },
    cli: { label: "CLI (fallback)", color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
    ollama: { label: "Ollama (fallback)", color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
    unknown: { label: "transport ?", color: "#94a3b8", bg: "rgba(148, 163, 184, 0.12)" },
    pending: { label: "conectando…", color: "#60a5fa", bg: "rgba(96, 165, 250, 0.12)" },
  };
  const key = streaming && !transport ? "pending" : (transport ?? "unknown");
  const v = variants[key];
  return (
    <span
      style={{
        marginLeft: 8,
        padding: "1px 7px",
        borderRadius: 999,
        background: v.bg,
        color: v.color,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
      title={
        key === "ws"
          ? "Conexão WebSocket direta com o OpenClaw Gateway — streaming token a token."
          : key === "cli"
          ? "Fallback CLI ativo (ATLAS_CHAT_ALLOW_FALLBACK). Latência alta, sem token streaming real."
          : key === "ollama"
          ? "Fallback Ollama local ativo (ATLAS_CHAT_ALLOW_FALLBACK)."
          : "Aguardando primeiro turno para detectar o transporte."
      }
    >
      {v.label}
    </span>
  );
}

function EmptyState() {
  return (
    <div style={emptyStateStyle}>
      <Bot size={42} style={{ color: "var(--accent)" }} />
      <h2 style={{ margin: 0, fontSize: 20 }}>Pronto para conversar</h2>
      <p style={{ margin: 0, color: "var(--text-secondary)", maxWidth: 520 }}>
        Microfone e voz já estão ativos. Diga{" "}
        <strong>&ldquo;ei Jarvis&rdquo;</strong> e fale seu comando em
        seguida — a resposta volta em tempo real (WebSocket) e o Jarvis fala
        de volta usando o TTS configurado (Fish Audio / ElevenLabs).
      </p>
      <ul style={emptyStateListStyle}>
        <li>
          <strong>📡 Modo Conversa</strong> — clique no botão{" "}
          <kbd style={kbdStyle}>Conversa</kbd> no topo: o microfone fica
          aberto e qualquer frase que você falar é enviada
          automaticamente, sem precisar dizer &ldquo;ei Jarvis&rdquo;.
          Ideal se o wake word estiver falhando.
        </li>
        <li>
          <strong>&ldquo;ei Jarvis&rdquo;</strong> / <strong>&ldquo;Atlas&rdquo;</strong>{" "}
          — wake word automático em pt-BR (aliases cobrem variantes como
          &ldquo;jarves&rdquo;, &ldquo;hey jarvis&rdquo;, &ldquo;olá jarvis&rdquo;)
        </li>
        <li>
          <kbd style={kbdStyle}>ESPAÇO</kbd> — segure para falar, solte para
          enviar (push-to-talk)
        </li>
        <li>🎙 clique no microfone do composer para gravar manualmente</li>
        <li>
          configure outras opções de wake em <kbd style={kbdStyle}>⚙ Wake</kbd>
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

/**
 * Conversation-mode button has three visual states: idle (off), live
 * (actively listening, pulsing green), and paused (engaged but waiting
 * for the round-trip / TTS to finish, soft amber).
 */
function conversationButtonStyle(active: boolean, listening: boolean): CSSProperties {
  if (!active) {
    return toggleButtonStyle(false);
  }
  if (listening) {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 10px",
      borderRadius: 8,
      background: "rgba(16, 185, 129, 0.18)",
      border: "1px solid #10b981",
      color: "#10b981",
      fontSize: 12,
      fontWeight: 600,
      cursor: "pointer",
      animation: "atlas-conversation-pulse 1.6s ease-in-out infinite",
    };
  }
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 8,
    background: "rgba(245, 158, 11, 0.18)",
    border: "1px solid #f59e0b",
    color: "#f59e0b",
    fontSize: 12,
    fontWeight: 600,
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

function conversationBannerStyle(listening: boolean): CSSProperties {
  // Green while the mic is open, amber while paused (round-trip / TTS).
  // Matching the button colors keeps the affordance obvious at a glance.
  const accent = listening ? "#10b981" : "#f59e0b";
  return {
    padding: "8px 20px",
    background: listening ? "rgba(16,185,129,0.10)" : "rgba(245,158,11,0.10)",
    borderBottom: `1px solid ${accent}`,
    color: accent,
    fontSize: 12,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  };
}

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

// Exemplo de regra condicional para o AGENTS.md — só dispara o
// HEARTBEAT workflow quando a mensagem do user é literalmente "HEARTBEAT"
// ou "PING". Para qualquer outra mensagem (saudação, pergunta, comando),
// segue o fluxo normal do agente.
const HEARTBEAT_FIX_SNIPPET = `## Heartbeat (apenas para pings de cron)

SE a mensagem do usuário for exatamente "HEARTBEAT" ou "PING"
(case-insensitive, sem outras palavras), ENTÃO:
  - Leia HEARTBEAT.md se existir
  - Responda HEARTBEAT_OK se nada precisa de atenção

CASO CONTRÁRIO (mensagem normal do usuário):
  - Ignore HEARTBEAT.md
  - Responda à pergunta diretamente em pt-BR`;

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
