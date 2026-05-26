import { NextRequest, NextResponse } from "next/server";
import { executeTool, type OrchestratorToolName } from "@/lib/orchestrator-tools";

export const dynamic = "force-dynamic";

const VALID: OrchestratorToolName[] = [
  "delegate_to",
  "decompose",
  "check_progress",
  "send_note",
  "review",
  "notify_user",
];

/**
 * Generic dispatch endpoint for orchestrator tool calls. The chat-stream
 * pipeline parses `\`\`\`atlas-tool <name>\n{json}\n\`\`\`` blocks emitted
 * by the LLM and POSTs them here. The UI also uses it for "run this tool
 * manually" buttons.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const tool = body?.tool as OrchestratorToolName | undefined;
    if (!tool || !VALID.includes(tool)) {
      return NextResponse.json(
        { error: `tool must be one of: ${VALID.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await executeTool(tool, body.args ?? {});
    const httpStatus = result.ok ? 200 : 400;
    return NextResponse.json(result, { status: httpStatus });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
