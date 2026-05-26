import { NextResponse } from "next/server";
import { runDispatcher } from "@/lib/task-dispatcher";

export const dynamic = "force-dynamic";

/**
 * Manual dispatcher kick — picks every inbox task whose deps are done and
 * whose assignee is under its cost cap, moves them to "assigned", and
 * bumps the agent's heartbeat to `thinking`. Returns a summary.
 *
 * In production, a cron will hit this every ~5s. For now the UI can call
 * it after every mutation that might unblock work.
 */
export async function POST() {
  try {
    const result = runDispatcher();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
