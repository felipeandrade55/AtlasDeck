import { NextRequest, NextResponse } from "next/server";
import { listMail, sendMail, type MailMessageType } from "@/lib/mailbox-db";

export const dynamic = "force-dynamic";

const VALID_TYPES: MailMessageType[] = [
  "queued_note",
  "direct_message",
  "inter_agent",
  "review_feedback",
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const messages = listMail({
      task_id: searchParams.get("task_id") || undefined,
      to_agent_id: searchParams.get("to_agent_id") || undefined,
      from_agent_id: searchParams.get("from_agent_id") || undefined,
      message_type: (searchParams.get("message_type") as MailMessageType) || undefined,
      unread_only: searchParams.get("unread_only") === "1",
      limit: Number(searchParams.get("limit") || 100),
      offset: Number(searchParams.get("offset") || 0),
      sort: (searchParams.get("sort") as "newest" | "oldest") || "newest",
    });
    return NextResponse.json({ messages, total: messages.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.to_agent_id || typeof body.to_agent_id !== "string") {
      return NextResponse.json({ error: "to_agent_id is required" }, { status: 400 });
    }
    if (!body?.body || typeof body.body !== "string") {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }
    const message_type = (body.message_type as MailMessageType) || "queued_note";
    if (!VALID_TYPES.includes(message_type)) {
      return NextResponse.json(
        { error: `message_type must be one of: ${VALID_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    const msg = sendMail({
      task_id: body.task_id ?? null,
      from_agent_id: body.from_agent_id ?? null,
      to_agent_id: body.to_agent_id,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      body: body.body,
      message_type,
    });
    return NextResponse.json({ message: msg });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
