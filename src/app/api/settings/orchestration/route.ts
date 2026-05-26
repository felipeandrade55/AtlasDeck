import { NextRequest, NextResponse } from "next/server";
import {
  getOrchestrationSettings,
  updateOrchestrationSettings,
} from "@/lib/orchestration-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: getOrchestrationSettings() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const next = updateOrchestrationSettings({
      autonomous_mode: typeof body.autonomous_mode === "boolean" ? body.autonomous_mode : undefined,
      require_user_approval:
        typeof body.require_user_approval === "boolean" ? body.require_user_approval : undefined,
      cost_caps_enforce:
        typeof body.cost_caps_enforce === "boolean" ? body.cost_caps_enforce : undefined,
      notify_on_delegation:
        typeof body.notify_on_delegation === "boolean" ? body.notify_on_delegation : undefined,
      default_reviewer_id:
        body.default_reviewer_id === null || typeof body.default_reviewer_id === "string"
          ? body.default_reviewer_id
          : undefined,
    });
    return NextResponse.json({ settings: next });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
