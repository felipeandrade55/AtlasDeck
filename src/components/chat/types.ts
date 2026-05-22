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
}

export interface AgentSummary {
  id: string;
  name: string;
  emoji: string;
  color: string;
}
