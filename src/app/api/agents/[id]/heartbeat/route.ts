import { NextRequest, NextResponse } from "next/server";
import { recordHeartbeat, type AgentState, AGENT_STATES } from "@/lib/agent-health";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));

    const state = (body.state as AgentState | undefined) ?? undefined;
    if (state && !AGENT_STATES.includes(state)) {
      return NextResponse.json(
        { error: `state must be one of: ${AGENT_STATES.join(", ")}` },
        { status: 400 },
      );
    }

    const health = recordHeartbeat({
      agent_id: id,
      state,
      current_task_id: body.current_task_id ?? null,
      metadata: body.metadata ?? null,
    });

    return NextResponse.json({ health });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
