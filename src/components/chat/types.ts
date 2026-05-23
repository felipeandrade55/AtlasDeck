export type ChatRole =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system";

export type ChatMessageStatus = "streaming" | "complete" | "error";

export interface ChatThread {
  id: string;
  title: string;
  agent_id: string;
  workspace: string | null;
  source: "web" | "telegram" | "openclaw_import";
  source_session_id: string | null;
  pinned: boolean;
  archived: boolean;
  metadata: Record<string, unknown>;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: string | null;
  audio_path: string | null;
  tts_path: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  status: ChatMessageStatus;
  error: string | null;
  created_at: string;
  /**
   * Backend that produced this assistant message ("ws", "cli", "ollama").
   * Set in-memory by the stream consumer; not persisted across reloads
   * yet — when we move that into chat-db this becomes a real column.
   */
  provider?: string;
  providerDetail?: string;
  firstTokenMs?: number;
  totalMs?: number;
  /**
   * True when the gateway buffered the whole reply instead of streaming
   * — heuristic: `first-delta` arrived at the same instant as `final`.
   * Surfaces a banner in the chat with the config the user needs to flip
   * on the server.
   */
  buffered?: boolean;
  /**
   * True when the agent reply was a stub like "Respondi no chat" — i.e.
   * the agent treated the chat as a notification and routed the real
   * answer elsewhere. Surfaces a banner pointing at AGENTS.md.
   */
  stubReply?: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  emoji: string;
  color: string;
}
