/**
 * Shared types for the Live Mission dashboard. Mirrors what /api/tasks
 * returns; keeping them in one place avoids the parent + each child
 * declaring slightly-different versions of the same shape.
 */
export type TaskStatus =
  | "planning"
  | "inbox"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  parent_task_id: string | null;
  delegated_by: string | null;
  assigned_to: string | null;
  status: TaskStatus;
  title: string;
  prompt: string;
  result: string | null;
  review_verdict: "approved" | "rejected" | "needs_revision" | null;
  review_notes: string | null;
  user_approved: boolean | null;
  user_feedback: string | null;
  cost_cents: number;
  tokens_in: number;
  tokens_out: number;
  depends_on: string[];
  workspace_path: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MailMessage {
  id: string;
  task_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string;
  subject: string | null;
  body: string;
  message_type: "queued_note" | "direct_message" | "inter_agent" | "review_feedback";
  created_at: string;
  read_at: string | null;
}

export interface Checkpoint {
  id: string;
  task_id: string;
  agent_id: string;
  checkpoint_data: Record<string, unknown>;
  created_at: string;
}

export interface LiveEvent {
  id: string;
  event_type: string;
  task_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export const STATUS_COLUMNS: TaskStatus[] = [
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "done",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planning: "Planning",
  inbox: "Inbox",
  assigned: "Assigned",
  in_progress: "In Progress",
  testing: "Testing",
  review: "Review",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  planning: "#a78bfa",
  inbox: "#94a3b8",
  assigned: "#3b82f6",
  in_progress: "#0ea5e9",
  testing: "#eab308",
  review: "#f97316",
  done: "#22c55e",
  failed: "#ef4444",
  cancelled: "#71717a",
};
