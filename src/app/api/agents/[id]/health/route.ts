import { NextRequest, NextResponse } from "next/server";
import { getHealth, listHealth } from "@/lib/agent-health";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (id === "all") {
      return NextResponse.json({ health: listHealth() });
    }
    const health = getHealth(id);
    if (!health) {
      return NextResponse.json(
        {
          health: {
            agent_id: id,
            last_heartbeat: null,
            current_task_id: null,
            state: "offline",
            state_changed_at: null,
            metadata: null,
          },
        },
      );
    }
    return NextResponse.json({ health });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
