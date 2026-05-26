import { NextRequest, NextResponse } from "next/server";
import { getTaskById, createCheckpoint, addTaskUsage } from "@/lib/tasks-db";
import { flushUnreadForDispatch } from "@/lib/mailbox-db";
import { recordHeartbeat } from "@/lib/agent-health";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Sub-agents call this at logical milestones during a task. We:
 *   1) record the checkpoint snapshot for crash recovery
 *   2) accumulate the cost/tokens reported in this delta
 *   3) refresh the agent's heartbeat (state = "working")
 *   4) flush any unread queued_notes destined for this agent so the agent
 *      can inject them into the next prompt round
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const agentId = body.agent_id || task.assigned_to;
    if (!agentId) {
      return NextResponse.json({ error: "agent_id is required (task has no assignee)" }, { status: 400 });
    }

    const checkpoint = createCheckpoint(id, agentId, body.data ?? {});

    if (body.cost_cents || body.tokens_in || body.tokens_out) {
      addTaskUsage(id, {
        cost_cents: body.cost_cents,
        tokens_in: body.tokens_in,
        tokens_out: body.tokens_out,
      });
    }

    recordHeartbeat({
      agent_id: agentId,
      current_task_id: id,
      state: body.state || "working",
    });

    const flushed = flushUnreadForDispatch(agentId);

    return NextResponse.json({
      checkpoint,
      notes: {
        count: flushed.messages.length,
        formatted: flushed.formatted,
        messages: flushed.messages,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
